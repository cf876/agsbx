FROM node:alpine3.22

# 安装原始 argosbx.sh 和 Node.js 服务可能需要的依赖。
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

# 复制 Node.js 服务和 Shell 脚本。
COPY nodejs/index.js nodejs/index.html nodejs/package.json ./
COPY nodejs/*.sh ./

# 安装 Node 依赖。
#
# 同时预先建立 sbx_update 文件，避免 argosbx.sh 启动时
# 在运行阶段再次尝试执行 apk add。
RUN npm install --omit=dev \
    && chmod 755 /app/*.sh \
    && touch /app/sbx_update

# 默认使用 root 运行。
#
# 不写 USER node：
# - 普通 docker run 默认为 root；
# - 平台若通过 --user 或 runAsUser 强制非 root，则会自动降级为该用户。
#
# 注意：不要在这里设置 ENV HOME=/root。
# 某些平台以非 root UID 强制运行时，HOME=/root 会造成无法创建 $HOME/agsbx。
#
# HOME 的最终处理建议交给启动包装器或平台环境变量。

EXPOSE 3000/tcp

CMD ["node", "index.js"]
