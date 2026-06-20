FROM machines/filestash:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends jq openssl \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER filestash

ENTRYPOINT ["/entrypoint.sh"]
