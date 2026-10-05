# stripe-reconstructor

RAID-6 风格的条带重建服务。条带由 `dataShards` 个数据片加上末尾两个校验片组成：

- **P**（索引 `dataShards`）：同位置数据字节的异或（XOR）。
- **Q**（索引 `dataShards + 1`）：在 GF(2⁸) 上以 `2^i` 为系数（`i` 为数据片索引，2 为生成元，本原多项式 `0x11d`）对数据字节加权求和。

任意至多两个缺片都可以从幸存片恢复；幸存片会与预期 SHA-256 摘要比对，以发现静默改写。

## API

### `POST /api/stripes/reconstruct`

请求体：

```json
{
  "dataShards": 4,
  "shardSize": 1024,
  "shards": ["<base64>", null, "<base64>", "<base64>", "<base64>", null],
  "digests": ["<64-hex sha256>", "... 共 dataShards+2 个 ..."]
}
```

- `dataShards`：整数，2–16。分片总数为 `dataShards + 2`，末两片依次为 P、Q。
- `shardSize`：整数，1–4096 字节；每个分片解码后必须恰好为该长度。
- `shards`：按索引排列的 Base64 字符串或 `null`（缺片）。
- `digests`：每片预期的 SHA-256 十六进制摘要（也可用 `expectedDigests` 字段名；接受 `sha256:` 前缀、大小写不敏感）。

**成功（200）**：

```json
{
  "dataShards": 4,
  "shardSize": 1024,
  "shards": ["<base64>", "... 全部 dataShards+2 片，按原索引 ..."],
  "recoveredIndices": [1, 5],
  "digests": ["<每片实际 SHA-256>"]
}
```

**失败**（绝不输出貌似完整的条带，响应中无 `shards` 字段）：

| 状态码 | 错误码 | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` / `INVALID_DATA_SHARDS` / `INVALID_SHARD_SIZE` / `INVALID_SHARDS` / `INVALID_DIGESTS` / `INVALID_DIGEST` / `INVALID_BASE64` / `INVALID_JSON` | 请求格式错误 |
| 409 | `SHARD_DIGEST_MISMATCH` | 幸存片与预期摘要不符（含长度不符）；不会把它当作缺片 |
| 409 | `PARITY_CONTRADICTION` | 幸存片之间与 P/Q 校验关系矛盾 |
| 409 | `RECONSTRUCTION_DIGEST_MISMATCH` | 重建出的分片与其预期摘要矛盾 |
| 422 | `ERASURE_LIMIT_EXCEEDED` | 缺片超过 2 个，超出恢复能力 |

错误响应形如：

```json
{
  "error": {
    "code": "SHARD_DIGEST_MISMATCH",
    "message": "...",
    "details": { "mismatches": [{ "shardIndex": 3, "expectedDigest": "...", "actualDigest": "..." }] }
  }
}
```

`details` 中带 `shardIndex` / `missingIndices` 等定位信息。

### `GET /health`

健康检查，返回 `{"status":"ok"}`。

## 本地运行

```sh
npm test          # 单元与接口测试
npm run build     # 生成可发布包 dist/*.tgz（npm pack）
npm start         # 启动服务，默认端口 3000（PORT 环境变量可改）
npm run smoke     # 对运行中的实例做冒烟（APP_BASE_URL 可覆盖）
```

## Docker / Docker Compose

```sh
APP_PORT=8080 docker compose up --build app          # 仅启动应用，宿主机端口由 APP_PORT 决定
APP_PORT=8080 docker compose up --build --exit-code-from verify verify
```

`verify` 是一次性服务：等 `app` 健康检查通过后，依次运行代码测试（`npm test`）、可发布包构建（`npm run build`）以及对恢复接口的冒烟测试，然后以退出码汇报结果并自行结束（全部通过为 0，否则非 0）。
