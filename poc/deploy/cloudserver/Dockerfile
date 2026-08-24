FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-w -s" -o /out/token-monitor-analytics-cloud ./cmd/cloudserver

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /data
COPY --from=build /out/token-monitor-analytics-cloud /app/cloudserver
ENV TOKEN_MONITOR_ANALYTICS_CLOUD_ADDR=:8080
ENV TOKEN_MONITOR_ANALYTICS_CLOUD_DB=/data/cloud.db
ENV TOKEN_MONITOR_ANALYTICS_CLOUD_SECRET_FILE=/run/secrets/token-monitor-analytics-cloud-secret
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/app/cloudserver"]
