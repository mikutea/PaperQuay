ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.1
FROM ${KEYCLOAK_IMAGE} AS builder
# Optimized startup must use the same persisted routing options as this build.
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true \
    --http-relative-path=/identity --http-management-relative-path=/

FROM ${KEYCLOAK_IMAGE}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
