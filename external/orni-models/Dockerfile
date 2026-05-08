FROM rust:latest AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev git && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY migrations/ migrations/
ENV CARGO_BUILD_JOBS=2
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

# GITHUB_TOKEN is mounted as a build secret (never lands in image layers) and
# rewrites https://github.com/ to use the token, so cargo can fetch the private
# said-solana git dependency. Build fails fast if the secret is missing.
RUN --mount=type=secret,id=github_token \
    test -s /run/secrets/github_token \
        || (echo "ERROR: github_token secret is required (set CARGO_NET_GITHUB_TOKEN in CI)" && exit 1) && \
    git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/".insteadOf "https://github.com/" && \
    cargo build --release -p orni-models-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/orni-models-api /usr/local/bin/
COPY migrations/ /app/migrations/
WORKDIR /app
EXPOSE 8080
CMD ["orni-models-api"]
