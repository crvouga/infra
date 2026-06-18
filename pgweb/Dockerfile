FROM sosedoff/pgweb:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /pgweb-bookmarks \
  && chown pgweb:pgweb /pgweb-bookmarks

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER pgweb

ENTRYPOINT ["/entrypoint.sh"]
