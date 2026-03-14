FROM rust:slim-bookworm AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/

RUN cargo build --release -p thumper-cloud

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/thumper-cloud /usr/local/bin/thumper-cloud

ENV BIND_ADDR=0.0.0.0:10000
EXPOSE 10000

CMD ["thumper-cloud"]

