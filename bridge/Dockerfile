# Hermes Agent — bridge image for pi-hub.
# Nous publishes no official image; install the pinned PyPI wheel instead
# (same pattern as /Users/yuri/Workdir/yuri/home-systems/k8s/images/hermes/Dockerfile).
# Renovate bumps HERMES_AGENT_VERSION.
# syntax=docker/dockerfile:1
FROM python:3.13-slim-trixie
ARG HERMES_AGENT_VERSION=0.19.0

RUN pip install --no-cache-dir "hermes-agent==${HERMES_AGENT_VERSION}"

# non-root, matching the container user the socket mount expects to see
RUN useradd -m hermes
USER hermes
WORKDIR /home/hermes

# plugin discovery scans ~/.hermes/plugins/*/ for plugin.yaml + __init__.py
COPY --chown=hermes:hermes hermes-hub-plugin/ /home/hermes/.hermes/plugins/hermes-hub/

CMD ["hermes", "serve"]