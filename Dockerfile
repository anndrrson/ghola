# Stage 1: Builder
FROM rust:1.85-slim AS builder

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
COPY mcp-server/Cargo.toml mcp-server/Cargo.toml
COPY cli/Cargo.toml cli/Cargo.toml
COPY daemon/Cargo.toml daemon/Cargo.toml

# Copy all source code
COPY crates/ crates/
COPY mcp-server/ mcp-server/
COPY cli/ cli/
COPY daemon/ daemon/

# Copy migrations (sqlx::migrate! embeds SQL at compile time)
COPY migrations-cloud/ migrations-cloud/

# Build only said-cloud in release mode
RUN cargo build --release -p said-cloud

# Stage 2: Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/said-cloud /usr/local/bin/said-cloud

ENV BIND_ADDR=0.0.0.0:8080

EXPOSE 8080

CMD ["said-cloud"]
