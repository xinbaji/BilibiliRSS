# BilibiliRSS v0.3.9

终于不用手动翻 GitHub 找新版了 —— 设置页多了一个「更新」按钮，油猴也会自己提示更新。

## 新增

- **设置页「更新」按钮**
  「BilibiliRSS」卡片里（GitHub 链接旁）新增更新按钮，点开即到最新版脚本地址。它指向远端仓库的 **latest Release 产物**，所以永远是最新版，不用随版本改地址 —— 在油猴里覆盖安装即可升级。

- **篡改猴自动更新**
  脚本头部加入 `@updateURL` / `@downloadURL`。装上这一版之后，往后有新版本油猴会自己提示，不用再手动来 Release 页。

## 关于镜像：实测结论是「不加速」

更新地址默认挂了国内镜像，但我实测了一遍 —— **在这台机器上直连反而最快**：

| 通道 | 状态 | 速度 |
|---|---|---|
| **直连 github** | OK | **176 KB/s** ← 最快 |
| ghproxy.net | OK | 106 KB/s ← 可用镜像里最好 |
| ghfast.top | OK | 105 KB/s |
| jsdelivr (cdn / fastly) | OK | 89 KB/s |
| gh-proxy.com | OK | 67 KB/s |
| ghfile.geekertao.top | OK | 37 KB/s |
| ghproxy.cc | 证书过期 | ✗ |
| hub.gitmirror.com / raw.gitmirror | 域名不存在 | ✗ |
| gh.llkk.cc / github.moeyy.xyz | 超时 15s | ✗ |
| gitproxy.click | 返回 0 字节 | ✗ |
| gcore.jsdelivr | 连接重置 | ✗ |

**12 个候选里 7 个是坏的。** 所以镜像的价值不在快，而在「github 打不开时的唯一出路」。

默认走 `ghproxy.net`（可用镜像里最快）。想换源只改一处常量 `GH_MIRROR`；想直连就把它设成 `''`。上面这份实测数据和失效清单已经作为注释留在代码里，免得以后重新踩。

## ⚠ 升级提醒

**装过 0.3.8 的需要手动更新这一次**：`@updateURL` 是 v0.3.9 才加的，0.3.8 里没有，所以油猴不会主动提示你有新版。

请用设置页的「更新」按钮（或本 Release 页）**覆盖安装一次**，之后就自动了。

## 升级说明

覆盖安装即可，配置、订阅、稍后再看数据全部保留。
