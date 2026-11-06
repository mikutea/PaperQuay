# Base manifests verified against the official registries; update through review.
# Base image build-argument overrides are deliberately not exposed.
FROM quay.io/keycloak/keycloak:26.8.1@sha256:3f3c5f8e03c614774b4bd9173b88391fefa4153bfc010d8012d59ad825377332 AS builder
# Optimized startup must use the same persisted routing options as this build.
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true \
    --http-relative-path=/identity --http-management-relative-path=/

FROM quay.io/keycloak/keycloak:26.8.1@sha256:3f3c5f8e03c614774b4bd9173b88391fefa4153bfc010d8012d59ad825377332
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
