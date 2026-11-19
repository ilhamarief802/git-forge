# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ilhamarief802/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ilhamarief802/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge that runs as one process and its own in-memory store: **git smart HTTP** (upload-pack protocol v2 and receive-pack v0, packfile read/write with `node:zlib` only, no git binary), **REST v3** (repositories, contents, labels, issues, pull requests, merge), **GraphQL v4** (the documents `gh` sends, introspection, mutations) and **MCP** (JSON-RPC over Streamable HTTP with the six tools github-mcp-server documents).

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dd12g1gh&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
