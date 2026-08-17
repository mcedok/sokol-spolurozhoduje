FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml ./
RUN mvn -q -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -q -DskipTests package

FROM build AS test
RUN mvn -q test

FROM eclipse-temurin:21-jre-noble AS runtime
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer poppler-utils \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin worker \
    && install -d -o worker -g worker -m 0700 /tmp/conversion
WORKDIR /app
COPY --from=build /workspace/target/document-conversion-worker-1.0.0-SNAPSHOT.jar /app/worker.jar
USER 10001:10001
ENV HOME=/home/worker TMPDIR=/tmp/conversion
ENTRYPOINT ["java", "-jar", "/app/worker.jar"]
