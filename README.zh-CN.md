# opencode-relay-fast

[English](./README.md)

一个 [OpenCode](https://opencode.ai) 插件，用一条 `/fast` 命令为你指定的第三方中转站 / 网关
provider 开启 OpenAI **优先处理**（`"service_tier": "priority"`，也就是 Codex 里的 *Fast mode*）。

最初是为 [sub2api](https://github.com/Wei-Shaw/sub2api) 这类暴露 OpenAI 兼容 `/v1` 接口的中转站写的，
但只要上游认 `service_tier`，任何 provider 都能用。

## 为什么需要它

OpenCode 没有按 provider 切换 `service_tier` 的开关。上游的
[opencodex-fast](https://github.com/Tarquinen/opencodex-fast) 插件能注入这个字段，
但只针对官方的 `chatgpt.com/backend-api/codex` 端点。如果你通过中转站访问 OpenAI 模型，
就没有任何东西会发送优先处理的标记。这个插件补上了这一环，而且不用每次切换档位都改 `opencode.json`。

## 工作原理

1. 你在配置里列出要开 Fast mode 的 OpenCode **provider ID**。插件从 OpenCode 自己的配置中读取它们的
   `options.baseURL`，URL 不需要重复填写。
2. `globalThis.fetch` 只包一层。只有**同时**满足以下条件时请求才会被改写：
   - Fast mode 已打开（`/fast on`）；
   - URL 是 `<baseURL>/responses` 或 `<baseURL>/chat/completions`（可配置）；
   - 方法是 POST，且 JSON body 里的 `model` 命中你的模型 glob；
   - `service_tier` 还没有被设成目标值。
3. 每次注入都会累加计数并写一条日志，方便你确认它真的生效了。

其他一切，包括别的 provider、别的端点、非 JSON body，都原样透传。

## 安装

### 从 npm 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["opencode-relay-fast"]
}
```

### 从源码安装（本地插件）

```bash
git clone https://github.com/wbxs2077/opencode-relay-fast.git
cd opencode-relay-fast
npm install
npm test          # 构建 dist/ 并运行测试
```

然后在 OpenCode 的全局插件目录（`~/.config/opencode/plugins/`，
Windows 下是 `%USERPROFILE%\.config\opencode\plugins\`）放一个一行的加载文件：

```js
// ~/.config/opencode/plugins/opencode-relay-fast.js
export { default } from "file:///绝对路径/opencode-relay-fast/dist/index.js";
```

安装后重启 OpenCode。

## 配置

把 [`examples/opencode-relay-fast.jsonc`](./examples/opencode-relay-fast.jsonc) 复制到
`~/.config/opencode/opencode-relay-fast.jsonc` 后修改。支持注释和尾随逗号。

```jsonc
{
  // opencode.json 里的 provider ID，baseURL 自动解析
  "providers": ["my-relay"],

  // 可选：额外的显式 baseURL（要带上 /v1 之类的前缀）
  "baseURLs": [],

  // 相对于 baseURL 的端点，下面是默认值
  "endpoints": ["/responses", "/chat/completions"],

  // 模型 ID glob，留空表示所有模型
  "models": ["gpt-5.5", "gpt-5.6-*"],

  // "auto" | "default" | "flex" | "priority"
  "serviceTier": "priority",

  // 可选：让 /fast 命令本身走一个便宜的模型
  // "commandModel": "my-relay/gpt-5.4-mini",

  "logInjections": true
}
```

`opencode.json` 里对应的 provider 长这样：

```jsonc
{
  "provider": {
    "my-relay": {
      "api": "openai",
      "options": { "baseURL": "https://relay.example.com/v1", "apiKey": "sk-..." },
      "models": { "gpt-5.6-sol": {}, "gpt-5.5": {} }
    }
  }
}
```

文件路径可以用环境变量 `OPENCODE_RELAY_FAST_CONFIG` 和 `OPENCODE_RELAY_FAST_STATE` 覆盖。

## 使用

```text
/fast            切换 Fast mode
/fast on         开启
/fast off        关闭
/fast status     查看状态、注入次数、解析出的目标、模型过滤
```

状态（开关、计数、最近一次注入）持久化在
`~/.config/opencode/opencode-relay-fast.state.json`，重启后仍然有效。

### `/fast` 命令会消耗一次很小的模型请求

OpenCode 的 `command.execute.before` 钩子目前还不能取消命令。插件会弹一个 TUI toast，
并把 prompt 替换成"原样回复这一行状态"的请求。把 `commandModel` 设成中转站里最便宜的模型，
这次请求就几乎不花钱。

## 验证它确实生效

1. `/fast on`
2. 用匹配的 provider 和模型正常发一条消息。
3. `/fast status` 里的 `Injected requests` 应该增加。
4. `~/.local/share/opencode/log/*.log` 里会有带模型和 URL 的 `Injected service tier` 记录。

注入只能证明 OpenCode 发出了这个标记。中转站是否转发、上游是否认，由它们决定。
需要确定的话请对比前后延迟，同时记住 OpenAI 对优先处理是按更高费率计费的。

## 开发

```bash
npm test      # tsc 构建 + node --test
npm run dev   # opencode plugin dev
```

匹配器 `RelayFastMatcher`、JSONC 去注释函数和 `parseConfig` 都有导出，方便测试和在其他插件里复用。

## 致谢

源自 [Tarquinen/opencodex-fast](https://github.com/Tarquinen/opencodex-fast)，它针对的是官方 Codex 后端。
本项目把这个思路推广到了任意中转站。

## 许可证

[MIT](./LICENSE)
