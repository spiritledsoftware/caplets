# GitHub Caplet

This Caplet wraps GitHub's hosted MCP endpoint:

```sh
caplets vault set GH_TOKEN --grant github
caplets serve
```

For self-hosted remote or hosted Cloud-backed runtime use:

```sh
caplets vault set GH_TOKEN --remote --grant github
```

Install it from this repo:

```sh
caplets install spiritledsoftware/caplets github
```
