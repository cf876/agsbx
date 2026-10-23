'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * 将大写环境变量补充为小写变量。
 *
 * 示例：
 * UUID=xxxx        -> uuid=xxxx
 * VLPT=443         -> vlpt=443
 * HYPT=8443        -> hypt=8443
 * SUB_PATH=my-sub  -> sub_path=my-sub
 * DOMAIN=test.com  -> domain=test.com
 */
function normalizeEnvironment() {
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) {
            continue;
        }

        const lowerKey = key.toLowerCase();

        if (process.env[lowerKey] === undefined) {
            process.env[lowerKey] = value;
        }
    }

    /*
     * 兼容 argosbx.sh 中使用的固定 Argo 变量名：
     *
     * ARGO_DOMAIN -> agn
     * ARGO_AUTH   -> agk
     */
    if (!process.env.agn && process.env.ARGO_DOMAIN) {
        process.env.agn = process.env.ARGO_DOMAIN;
    }

    if (!process.env.agk && process.env.ARGO_AUTH) {
        process.env.agk = process.env.ARGO_AUTH;
    }
}

normalizeEnvironment();

/**
 * 仅识别下列真值：
 *
 * y / yes / true / 1
 *
 * 以下及其他任意值均视为关闭：
 *
 * f / no / false / 0 / 空值 / 未设置 / 任意其他内容
 */
function isEnabled(value) {
    return ['y', 'yes', 'true', '1'].includes(
        String(value || '').trim().toLowerCase()
    );
}

/**
 * 订阅开关。
 *
 * 支持：
 * sub=y
 * SUB=YES
 * sub=true
 * SUB=1
 */
const SUB_ENABLED = isEnabled(process.env.sub);

/**
 * Node.js 服务端口。
 */
const rawPort = process.env.PORT || process.env.port || '3000';
const parsedPort = Number(rawPort);

const PORT = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
    ? parsedPort
    : 3000;

if (PORT === 3000 && String(rawPort) !== '3000') {
    console.warn(`PORT 设置无效：${rawPort}，已自动使用默认端口 3000。`);
}

/**
 * 域名仅用于自动访问任务。
 *
 * 示例：
 * DOMAIN=example.com
 * DOMAIN=https://example.com
 */
const DOMAIN = process.env.DOMAIN || process.env.domain || '';

/**
 * Argosbx 工作目录。
 */
const agsbxDir = path.join(process.env.HOME || '/root', 'agsbx');

/**
 * Argosbx 实际 UUID 文件。
 *
 * 无论 UUID 是环境变量传入的，还是 argosbx.sh 自动生成的，
 * 最终都以此文件内容为准。
 */
const uuidFilePath = path.join(agsbxDir, 'uuid');

/**
 * 原始 argosbx.sh 生成的订阅文件。
 */
const subscriptionFiles = {
    nodes: path.join(agsbxDir, 'jhsub.txt'),
    clash: path.join(agsbxDir, 'clmi.yaml'),
    singbox: path.join(agsbxDir, 'sbox.json')
};

/**
 * 兼容少数旧版配套脚本。
 */
const legacyNodesFile = path.join(agsbxDir, 'jh.txt');

/**
 * index.html 应与 index.js 位于同一目录。
 */
const indexHtmlPath = path.join(__dirname, 'index.html');

/**
 * 初始化完成后才会赋值。
 */
let actualUuid = '';
let SUB_PATH = '';

/**
 * 获取用户自定义订阅路径。
 *
 * SUB_PATH=my-sub
 * sub_path=my-sub
 *
 * 会清理开头及末尾的 /。
 */
function getConfiguredSubPath() {
    const rawPath = process.env.SUB_PATH || process.env.sub_path || '';

    return String(rawPath)
        .trim()
        .replace(/^\/+|\/+$/g, '');
}

/**
 * 从 Argosbx 文件中读取最终 UUID。
 */
function readActualUuid() {
    if (!fs.existsSync(uuidFilePath)) {
        throw new Error(
            `未找到 UUID 文件：${uuidFilePath}。` +
            '请确认 Argosbx 初始化是否成功完成。'
        );
    }

    const uuid = fs.readFileSync(uuidFilePath, 'utf8').trim();

    if (!uuid) {
        throw new Error(`UUID 文件内容为空：${uuidFilePath}`);
    }

    return uuid;
}

/**
 * 匹配要执行的 Shell 启动脚本，但不固定写死其名称。
 *
 * 优先级：
 * 1. START_SCRIPT / start_script 指定的脚本；
 * 2. 当前目录中唯一匹配 start*.sh 的文件。
 *
 * 示例：
 * START_SCRIPT=start.sh
 * START_SCRIPT=argosbx.sh
 * START_SCRIPT=install-argosbx.sh
 */
function resolveStartScript() {
    const configuredScript =
        process.env.START_SCRIPT ||
        process.env.start_script ||
        '';

    if (configuredScript) {
        const scriptPath = path.isAbsolute(configuredScript)
            ? configuredScript
            : path.resolve(__dirname, configuredScript);

        if (!fs.existsSync(scriptPath)) {
            throw new Error(`START_SCRIPT 指定的文件不存在：${scriptPath}`);
        }

        if (!fs.statSync(scriptPath).isFile()) {
            throw new Error(`START_SCRIPT 不是普通文件：${scriptPath}`);
        }

        return scriptPath;
    }

    const shellFiles = fs.readdirSync(__dirname)
        .filter((fileName) => {
            return /\.sh$/i.test(fileName) && /(start|argosbx)/i.test(fileName);
        })
        .map((fileName) => path.join(__dirname, fileName))
        .filter((filePath) => fs.statSync(filePath).isFile());

    if (shellFiles.length === 0) {
        throw new Error(
            `当前目录未找到文件名含 start 或 argosbx 的 .sh 启动脚本：${__dirname}。\n` +
            '可通过 START_SCRIPT 显式指定要执行的脚本。'
        );
    }

    if (shellFiles.length > 1) {
        throw new Error(
            '检测到多个可能的 Shell 启动脚本，无法安全自动选择：\n' +
            shellFiles.join('\n') +
            '\n请通过 START_SCRIPT 显式指定，例如：START_SCRIPT=start.sh'
        );
    }

    return shellFiles[0];
}

/**
 * 构建传给 Shell 的环境变量。
 *
 * 注意：
 * 原始 argosbx.sh 中只要 sub 非空，就会额外启动 BusyBox HTTP 服务。
 *
 * 本 Node.js 版本约定：
 * - sub=y 只控制 Node.js 域名订阅是否开放；
 * - 不把 sub / SUB 传给 Shell；
 * - 从而避免原始 Shell 同时额外开放 BusyBox 订阅端口。
 */
function buildShellEnvironment() {
    const shellEnv = { ...process.env };

    for (const key of Object.keys(shellEnv)) {
        if (key.toLowerCase() === 'sub') {
            delete shellEnv[key];
        }
    }

    return shellEnv;
}

async function prepareAlpineLocalDirectory() {
    /*
     * Argosbx 在 Alpine 环境中会向 /etc/local.d 写入
     * alpineargosbx.start / alpinesubsbx.start 等启动脚本。
     *
     * 某些精简 Alpine 镜像没有预创建该目录，
     * 导致 Argosbx 虽可正常运行，但开机恢复脚本写入失败。
     */
    const alpineLocalDirectory = '/etc/local.d';

    try {
        await fs.promises.mkdir(alpineLocalDirectory, {
            recursive: true,
            mode: 0o755
        });

        console.log(`已确认 Alpine 启动脚本目录存在：${alpineLocalDirectory}`);
    } catch (error) {
        /*
         * 不能创建时不阻止 Argosbx 主流程：
         * 例如容器文件系统为只读，或运行账号权限不足。
         */
        console.warn(
            `无法创建 ${alpineLocalDirectory}，` +
            `开机自动恢复功能可能不可用：${error.message}`
        );
    }
}

/**
 * 运行 Shell 启动脚本，并等待其结束。
 */
async function runStartScript(scriptPath) {
    let scriptContent;

    try {
        /*
         * 读取原始脚本，但不修改它。
         */
        scriptContent = await fs.promises.readFile(scriptPath, 'utf8');
    } catch (error) {
        throw new Error(
            `无法读取启动脚本：${scriptPath}；原因：${error.message}`
        );
    }

    /*
     * 去掉 UTF-8 BOM。
     *
     * 如果脚本来自某些 Windows 编辑器或网页复制，
     * 文件开头可能含有 \uFEFF，Bash 会将其误当作命令的一部分。
     */
    scriptContent = scriptContent.replace(/^\uFEFF/, '');

    /*
     * 将 Windows CRLF（\r\n）及旧式 CR（\r）
     * 统一转换为 Linux / Unix LF（\n）。
     *
     * 不修改 /app/argosbx.sh 本身，仅清洗内存中的副本。
     */
    scriptContent = scriptContent.replace(/\r\n?/g, '\n');

    /*
     * 确保最后一行存在换行符。
     */
    if (!scriptContent.endsWith('\n')) {
        scriptContent += '\n';
    }

    /*
     * 在 Argosbx 执行前补齐 Alpine 精简镜像中可能缺失的目录。
     */
    await prepareAlpineLocalDirectory();

    console.log(`启动脚本：${scriptPath}`);
    console.log('已在内存中规范化 Shell 脚本换行符，开始执行...');

    return new Promise((resolve, reject) => {
        /*
         * 不传入脚本路径：
         *
         * bash 将从 stdin 读取已经规范化的脚本内容。
         * 因此：
         * - 不需要 chmod；
         * - 不需要创建临时 .sh 文件；
         * - 不会修改 argosbx.sh；
         * - 不受原脚本 CRLF 换行符影响。
         */
        const child = spawn('bash', [], {
            cwd: path.dirname(scriptPath),
            env: buildShellEnvironment(),
            stdio: ['pipe', 'pipe', 'pipe']
        });

        child.stdout.on('data', (data) => {
            process.stdout.write(data);
        });

        child.stderr.on('data', (data) => {
            process.stderr.write(data);
        });

        child.on('error', (error) => {
            reject(new Error(`无法启动 Bash：${error.message}`));
        });

        child.stdin.on('error', (error) => {
            /*
             * Bash 提前退出时，stdin 可能触发 EPIPE。
             * 真正的失败信息由 close 事件中的退出码处理。
             */
            if (error.code !== 'EPIPE') {
                console.error(`写入 Bash 标准输入失败：${error.message}`);
            }
        });

        child.on('close', (code, signal) => {
            if (code === 0) {
                console.log('Shell 初始化脚本执行完成。');
                resolve();
                return;
            }

            reject(
                new Error(
                    `Shell 初始化脚本执行失败，退出码：${code ?? '未知'}，` +
                    `信号：${signal ?? '无'}`
                )
            );
        });

        /*
         * 把已规范化的脚本交给 Bash。
         */
        child.stdin.end(scriptContent);
    });
}

/**
 * 获取项目完整 URL，仅供 AUTO_ACCESS 使用。
 */
function getProjectUrl() {
    if (!DOMAIN) {
        return '';
    }

    const domain = String(DOMAIN).trim();

    if (!domain || domain === 'YOUR.DOMAIN') {
        return '';
    }

    if (/^https?:\/\//i.test(domain)) {
        return domain.replace(/\/+$/, '');
    }

    return `https://${domain.replace(/\/+$/, '')}`;
}

/**
 * AUTO_ACCESS=true / yes / y / 1 时启用。
 */
const AUTO_ACCESS = isEnabled(
    process.env.AUTO_ACCESS || process.env.auto_access
);

/**
 * 向外部访问任务服务提交项目 URL。
 *
 * 默认关闭，仅 AUTO_ACCESS 为真时启用。
 */
async function addVisitTask() {
    const projectUrl = getProjectUrl();

    if (!AUTO_ACCESS || !projectUrl) {
        console.log('未启用自动访问任务。');
        return null;
    }

    const requestBody = JSON.stringify({
        url: projectUrl
    });

    const options = {
        hostname: 'oooo.serv00.net',
        path: '/add-url',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody)
        }
    };

    return new Promise((resolve) => {
        const request = https.request(options, (response) => {
            let responseData = '';

            response.on('data', (chunk) => {
                responseData += chunk;
            });

            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    console.log('自动访问任务已提交。');
                    resolve(responseData);
                    return;
                }

                console.error(
                    `自动访问任务提交失败：HTTP ${response.statusCode}`
                );

                resolve(null);
            });
        });

        request.on('error', (error) => {
            console.error(`自动访问任务提交失败：${error.message}`);
            resolve(null);
        });

        request.write(requestBody);
        request.end();
    });
}

/**
 * 返回订阅文件内容。
 */
function sendFileContent(res, filePath, contentType, fallbackPath = null) {
    let targetFile = filePath;

    if (
        !fs.existsSync(targetFile) &&
        fallbackPath &&
        fs.existsSync(fallbackPath)
    ) {
        targetFile = fallbackPath;
    }

    if (!fs.existsSync(targetFile)) {
        res.writeHead(503, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });

        res.end(
            '订阅文件暂未生成，请检查 Argosbx 初始化是否成功完成。\n' +
            `预期文件：${filePath}\n`
        );

        return;
    }

    fs.readFile(targetFile, 'utf8', (error, data) => {
        if (error) {
            console.error(`读取订阅文件失败 [${targetFile}]：${error.message}`);

            res.writeHead(500, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });

            res.end('读取订阅文件失败。');
            return;
        }

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });

        res.end(data);
    });
}

/**
 * HTTP 服务。
 */
const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Allow': 'GET, HEAD'
        });

        res.end('Method Not Allowed');
        return;
    }

    let urlPath = req.url.split('?')[0];

    try {
        urlPath = decodeURIComponent(urlPath);
    } catch (error) {
        res.writeHead(400, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        res.end('Bad Request');
        return;
    }

    const subscriptionPath = SUB_ENABLED ? `/${SUB_PATH}` : '';
    const clashPath = SUB_ENABLED ? `${subscriptionPath}/clash` : '';
    const singboxPath = SUB_ENABLED ? `${subscriptionPath}/singbox` : '';

    /**
     * 首页。
     */
    if (urlPath === '/') {
        fs.readFile(indexHtmlPath, 'utf8', (error, data) => {
            if (error) {
                const subscriptionInfo = SUB_ENABLED
                    ? [
                        '<h3>Argosbx Node.js 服务已启动</h3>',
                        `<p>聚合订阅：<code>${subscriptionPath}</code></p>`,
                        `<p>Clash/Mihomo：<code>${clashPath}</code></p>`,
                        `<p>Sing-box：<code>${singboxPath}</code></p>`
                    ].join('')
                    : '<h3>Argosbx Node.js 服务已启动</h3><p>订阅功能未启用。</p>';

                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                });

                res.end(subscriptionInfo);
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });

            res.end(data);
        });

        return;
    }

    /**
     * 聚合节点订阅。
     */
    if (SUB_ENABLED && urlPath === subscriptionPath) {
        sendFileContent(
            res,
            subscriptionFiles.nodes,
            'text/plain; charset=utf-8',
            legacyNodesFile
        );
        return;
    }

    /**
     * Clash / Mihomo YAML 订阅。
     */
    if (SUB_ENABLED && urlPath === clashPath) {
        sendFileContent(
            res,
            subscriptionFiles.clash,
            'text/yaml; charset=utf-8'
        );
        return;
    }

    /**
     * Sing-box JSON 订阅。
     */
    if (SUB_ENABLED && urlPath === singboxPath) {
        sendFileContent(
            res,
            subscriptionFiles.singbox,
            'application/json; charset=utf-8'
        );
        return;
    }

    res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
    });

    res.end('404 Not Found');
});

/**
 * 主初始化流程：
 *
 * 1. 匹配并执行 Shell 脚本；
 * 2. 等待 Argosbx 初始化结束；
 * 3. 从 $HOME/agsbx/uuid 获取实际 UUID；
 * 4. 确定订阅路径；
 * 5. 启动 HTTP 服务。
 */
async function initialize() {
    const startScriptPath = resolveStartScript();

    await runStartScript(startScriptPath);

    if (SUB_ENABLED) {
        actualUuid = readActualUuid();

        /*
         * 优先使用 SUB_PATH / sub_path。
         * 未设置时，以 Argosbx 最终真实 UUID 作为订阅路径。
         */
        const configuredSubPath = getConfiguredSubPath();

        SUB_PATH = configuredSubPath || actualUuid;

        /*
         * 只有订阅路径自动使用 UUID 时才显示 UUID，
         * 便于用户从日志中获取订阅地址。
         *
         * 设置了 SUB_PATH 时，不输出 UUID 或订阅路径。
         */
        if (!configuredSubPath) {
            console.log(
                `订阅路径未设置，已使用 Argosbx 实际 UUID：${actualUuid}`
            );
        } else {
            console.log('已使用自定义订阅路径。');
        }
    } else {
        console.log(
            '订阅功能未启用：sub 仅在 y / yes / true / 1 时启用。'
        );
    }

    server.listen(PORT, () => {
        const projectUrl = getProjectUrl();

        console.log(`HTTP 服务已启动，监听端口：${PORT}`);
        console.log('根目录页面：/');

        if (SUB_ENABLED) {
            console.log('订阅服务已启用。');

            /*
             * 未设置 SUB_PATH 时，订阅路径就是上方输出的实际 UUID。
             * 设置了 SUB_PATH 时，不在日志中输出订阅路径。
             */
            if (!getConfiguredSubPath()) {
                console.log('订阅路径使用上方显示的 UUID。');
                console.log('可用路径：/{UUID}、/{UUID}/clash、/{UUID}/singbox');
            }
        }

        if (projectUrl) {
            console.log(`项目地址：${projectUrl}`);
        }

        addVisitTask();
    });
}

initialize().catch((error) => {
    console.error(`初始化失败：${error.message}`);
    process.exit(1);
});
