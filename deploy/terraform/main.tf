# Ghola v2 confidential-AI infrastructure.
#
# One m5.xlarge host that boots an EIF and connects to the Ghola relay
# over WSS. The host is outbound-only: nothing listens on the public
# internet, so the SG denies all inbound traffic except ops SSH if you
# provide `ops_ssh_cidr` (defaults to none).
#
# Usage:
#   cd deploy/terraform
#   terraform init
#   terraform apply -var="eif_s3_uri=s3://ghola-eifs/ghola-provider-<sha>.eif"
#
# The runbook (deploy/runbook.md) covers prerequisites: the EIF must
# already be uploaded to S3, the allowlist signature + provider auth
# key must already live in SSM Parameter Store under /ghola/provider/*.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ---- Variables ----

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region. Nitro Enclaves are available in all major regions."
}

variable "instance_type" {
  type        = string
  default     = "m5.xlarge"
  description = "Instance type. Must be a Nitro Enclaves-capable family (m5, c5, r5, ...)."
}

variable "eif_s3_uri" {
  type        = string
  description = "S3 URI of the EIF to load, e.g. s3://ghola-eifs/ghola-provider-abc123.eif"
}

variable "ops_ssh_cidr" {
  type        = string
  default     = ""
  description = "Optional CIDR allowed to SSH. Leave empty to disable inbound 22 entirely (recommended)."
}

variable "key_name" {
  type        = string
  default     = ""
  description = "Existing EC2 keypair name for emergency SSH. Empty = no SSH access."
}

variable "name_prefix" {
  type        = string
  default     = "ghola-provider"
  description = "Tag/name prefix for all resources."
}

variable "relay_host" {
  type        = string
  default     = "ghola-relay.onrender.com"
  description = "Relay hostname the vsock-proxy dials. Must match the SNI override the in-enclave provider expects (RELAY_SNI_OVERRIDE)."
}

variable "relay_port" {
  type        = number
  default     = 443
  description = "Relay TCP port. Almost always 443."
}

# ---- Networking ----
#
# A minimal VPC with one public subnet. The instance gets a public IP so
# its outbound WSS connection to the relay doesn't need a NAT gateway.
# (NAT would work too but it's a $30/month line item we don't need.)

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.42.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "${var.aws_region}a"

  tags = {
    Name = "${var.name_prefix}-public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.name_prefix}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ---- Security group ----
#
# Outbound HTTPS only (which covers WSS to the relay and HTTPS pulls
# from S3/SSM). Inbound is denied by default; SSH only opens up if the
# operator explicitly provides a CIDR.

resource "aws_security_group" "host" {
  name        = "${var.name_prefix}-host"
  description = "Outbound 443 only; inbound disabled (push-only WSS provider)."
  vpc_id      = aws_vpc.main.id

  egress {
    description = "HTTPS / WSS outbound"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS outbound"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = var.ops_ssh_cidr == "" ? [] : [var.ops_ssh_cidr]
    content {
      description = "Ops SSH (optional)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  tags = {
    Name = "${var.name_prefix}-host"
  }
}

# ---- IAM ----
#
# Instance role with read-only access to two SSM parameters and the EIF
# bucket. Nothing else — the host is supposed to be the least-privileged
# component in the system.

resource "aws_iam_role" "host" {
  name = "${var.name_prefix}-host-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "host" {
  name = "${var.name_prefix}-host-policy"
  role = aws_iam_role.host.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadProviderSecrets"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:*:parameter/ghola/provider/auth-key",
          "arn:aws:ssm:${var.aws_region}:*:parameter/ghola/provider/allowlist-sig"
        ]
      },
      {
        Sid    = "DecryptParameterKMS"
        Effect = "Allow"
        Action = ["kms:Decrypt"]
        # Locked to the default SSM key. If you use a CMK, replace this
        # with the CMK ARN.
        Resource = ["arn:aws:kms:${var.aws_region}:*:key/aws/ssm"]
      },
      {
        Sid    = "ReadEif"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          # Allow any bucket — operator passes the URI at apply time.
          # Tighten with a specific bucket ARN before production.
          "arn:aws:s3:::*",
          "arn:aws:s3:::*/*"
        ]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name_prefix}-host-profile"
  role = aws_iam_role.host.name
}

# ---- AMI ----

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

# ---- Instance ----

resource "aws_instance" "host" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true
  key_name                    = var.key_name == "" ? null : var.key_name

  # Critical: this is what makes the instance Nitro-Enclaves-capable.
  enclave_options {
    enabled = true
  }

  # Block device — give the host enough room to cache the EIF + Ollama
  # model weights if they're not baked into the image.
  root_block_device {
    volume_size = 60
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user-data.sh", {
    eif_s3_uri = var.eif_s3_uri
    aws_region = var.aws_region
    relay_host = var.relay_host
    relay_port = var.relay_port
  })

  # Force replacement when user-data changes so a new EIF rolls out
  # cleanly. (User-data is hashed by AWS but Terraform doesn't replace
  # on user-data drift by default — this trigger fixes that.)
  user_data_replace_on_change = true

  tags = {
    Name = "${var.name_prefix}-host"
  }
}

# ---- Outputs ----

output "public_ip" {
  description = "Public IPv4 of the enclave host. Ops uses this for SSH (if enabled) and for nitro-cli describe-enclaves over SSH."
  value       = aws_instance.host.public_ip
}

output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.host.id
}

output "iam_role_arn" {
  description = "Instance role ARN — useful when granting it access to additional SSM params."
  value       = aws_iam_role.host.arn
}
