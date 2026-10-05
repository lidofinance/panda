FROM denoland/deno:alpine-2.9.7@sha256:8ce780168429c4bf5962652e6cbea3fd45254ae902069e90585fb33f74c56968 AS deno
FROM docker:29.2.0-dind@sha256:a284d31e4db9a9916fd9be44380263eaeafedf0e3048a859f978922b5a0c16fc

COPY --from=deno /bin/deno /usr/local/bin/deno
COPY --from=deno /usr/local/lib/glibc/ /usr/local/lib/glibc/
COPY --from=deno /lib/ld-linux-* /lib/
COPY --from=deno /lib64/ /lib64/
ENV DENO_DIR=/opt/deno-cache DENO_USE_CGROUPS=1 DOCKER_TLS_CERTDIR="" \
    DOCKER_HOST=unix:///var/run/docker.sock PANDA_DOCKER_SOCKET=/var/run/docker.sock \
    PANDA_DATA_DIR=/data/panda
WORKDIR /opt/panda
COPY deno.json deno.lock ./
COPY LICENSE ./
COPY src/ src/
COPY bakes/ bakes/
COPY container/ container/
RUN deno cache --config=deno.json --frozen-lockfile container/main.ts container/health.ts container/clients.ts \
    && chmod 755 /opt/panda/container/panda \
    && ln -s /opt/panda/container/panda /usr/local/bin/panda
COPY release.json ./
COPY .cache/baker/images/ .cache/baker/images/
ARG SOURCE_COMMIT
ARG PROFILE
ARG REVISION
ARG BAKE_KEY
LABEL org.opencontainers.image.source="https://github.com/eddort/panda" \
    org.opencontainers.image.revision=$SOURCE_COMMIT \
    org.opencontainers.image.version=$REVISION \
    io.panda.profile=$PROFILE io.panda.bake.key=$BAKE_KEY
VOLUME ["/data/panda"]
EXPOSE 8545 5052 5062
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=10s --start-period=180s --retries=12 \
    CMD ["deno", "run", "--config=deno.json", "--cached-only", "-A", "container/health.ts"]
ENTRYPOINT ["docker-init", "--", "deno", "run", "--config=deno.json", "--cached-only", "-A", "container/main.ts"]
CMD []
