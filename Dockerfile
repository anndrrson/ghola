# Stage 1: Builder — tracks latest stable Rust; pinned 1.85-slim was too old
# for home@0.5.12 which requires rustc 1.88+.
FROM rust:slim-bookworm AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY Cargo.toml Cargo.lock ./
COPY crates/said-types/Cargo.toml crates/said-types/Cargo.toml
COPY crates/said-core/Cargo.toml crates/said-core/Cargo.toml
COPY crates/said-solana/Cargo.toml crates/said-solana/Cargo.toml
COPY crates/said-cloud/Cargo.toml crates/said-cloud/Cargo.toml
COPY crates/said-wasm/Cargo.toml crates/said-wasm/Cargo.toml
COPY crates/said-x402/Cargo.toml crates/said-x402/Cargo.toml
COPY crates/said-turnkey/Cargo.toml crates/said-turnkey/Cargo.toml
COPY crates/ghola-gateway/Cargo.toml crates/ghola-gateway/Cargo.toml
COPY crates/thumper-types/Cargo.toml crates/thumper-types/Cargo.toml
COPY crates/thumper-relay/Cargo.toml crates/thumper-relay/Cargo.toml
COPY crates/thumper-mcp/Cargo.toml crates/thumper-mcp/Cargo.toml
COPY crates/thumper-cli/Cargo.toml crates/thumper-cli/Cargo.toml
COPY crates/thumper-cloud/Cargo.toml crates/thumper-cloud/Cargo.toml
COPY crates/ghola-home/Cargo.toml crates/ghola-home/Cargo.toml
COPY mcp-server/Cargo.toml mcp-server/Cargo.toml
COPY cli/Cargo.toml cli/Cargo.toml
COPY daemon/Cargo.toml daemon/Cargo.toml
COPY integration-tests/Cargo.toml integration-tests/Cargo.toml

# Copy all source code
COPY crates/ crates/
COPY mcp-server/ mcp-server/
COPY cli/ cli/
COPY daemon/ daemon/
COPY integration-tests/ integration-tests/

# Copy migrations (sqlx::migrate! embeds SQL at compile time)
COPY migrations/cloud/ migrations/cloud/

# Build only said-cloud in release mode
RUN cargo build --release -p said-cloud

# Stage 2: Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/said-cloud /usr/local/bin/said-cloud

ENV BIND_ADDR=0.0.0.0:8080

RUN useradd --system --no-create-home --uid 65532 nonroot
USER nonroot

EXPOSE 8080

CMD ["said-cloud"]
