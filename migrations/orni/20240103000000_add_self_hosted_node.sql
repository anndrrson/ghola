-- Allow models to use self-hosted inference nodes
ALTER TABLE models ADD COLUMN self_hosted_node_id UUID;
ALTER TABLE models ADD COLUMN self_hosted_endpoint TEXT;
