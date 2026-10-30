FROM node:alpine3.22

RUN apk add --no-cache \
        bash \
        busybox-extras \
        ca-certificates \
        coreutils \
        curl \
        findutils \
        gcompat \
        iproute2 \
        iptables \
        libc6-compat \
        openssl \
        procps \
        tzdata \
        util-linux \
        virt-what \
        wget \
    && update-ca-certificates

WORKDIR /app

COPY index.js index.html package.json ./
COPY *.sh ./

RUN npm install --omit=dev \
    && chmod 755 /app/*.sh \
    && touch /app/sbx_update

EXPOSE 3000/tcp

CMD ["node", "index.js"]
