# Bilibili Search Fix

B站搜索结果纯净修复：精准保留与搜索词相关的内容，告别算法杂乱推流与信息流广告。

[![Install](https://img.shields.io/badge/Install-Tampermonkey-brightgreen?style=flat-square&logo=tampermonkey)](https://raw.githubusercontent.com/NEPHERAovo/bilibili-search-fix/main/bilibili-search-fix.user.js)
[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://raw.githubusercontent.com/NEPHERAovo/bilibili-search-fix/main/bilibili-search-fix.user.js)

> **声明与致谢**：本项目原始灵感来源于 [houliabc/bilibili-search-purify](https://github.com/houliabc/bilibili-search-purify)。新版本未采用其代码实现，而是基于现代 B 站底层 API 请求拦截（Fetch / XHR / SSR / Pinia 水合拦截）、确定性标签关联池与无侵入 DOM 协同重构开发，实现了更高精准度、零闪烁与零误杀的纯净检索效果。

---

## 一键安装

> 请确保浏览器已安装脚本管理器扩展：[Tampermonkey（篡改猴）](https://www.tampermonkey.net/) 或 [Violentmonkey（暴力猴）](https://violentmonkey.github.io/)。

👉 **[点击这里一键安装脚本 (Direct Install)](https://raw.githubusercontent.com/NEPHERAovo/bilibili-search-fix/main/bilibili-search-fix.user.js)**

备用镜像链接（如遇 Raw 访问缓慢）：  
👉 **[点击使用镜像一键安装 (FastMirror)](https://fastly.jsdelivr.net/gh/NEPHERAovo/bilibili-search-fix@main/bilibili-search-fix.user.js)**

点击上方链接后，油猴插件将自动识别并弹出安装确认界面，点击“安装”即可开箱即用。

---

## 效果展示

> [!TIP]
> **默认配置说明**：
> 脚本安装后**默认开启「弱关联」与「模糊展示」**。
> - **为什么默认使用模糊展示**：用于直观判断是否发生误判过滤。模糊卡片居中醒目标明「弱相关内容」，如果发现是想要浏览的内容，只需**鼠标左键轻点卡片即可立即解除模糊**正常观看。
> - **强烈推荐使用弱关联模式**：弱关联通过动态汇聚强相关视频的标签池（如搜索 `deepseek` 智能关联 `深度思考`、`大肥鱼` 等核心圈子标签；搜索 `minecraft` 智能关联 `我的世界`、`MC` 等中英对照标签），能够在准确过滤无关营销推流的同时，大幅保留相关衍生内容，**误杀率远低于严格强关联模式**。

### 1. 默认模糊展示（标记弱相关内容，保留页面布局）
![默认模糊展示效果](assets/preview-blur.jpg)

### 2. 点击卡片立即解除模糊（直观核验是否误判，确认确实为无关内容）
![点击解除模糊查看对比](assets/preview-unblurred.jpg)

---

## 核心特性

- **底层数据拦截净化**：在数据交付页面渲染前（Fetch / XHR / Pinia SSR 水合）完成清洗，页面网格原生对齐，无卡片突兀消失的视觉闪烁。
- **双档展示模式**：
  - **模糊展示（默认）**：不相关视频仅虚化覆盖，显示“弱相关内容”，点击可随时解除模糊查看，便于直观验证过滤效果。
  - **直接过滤**：彻底剔除不相关视频与推广卡片，网格紧凑自然。
- **双档过滤强度**：
  - **弱关联（默认 & 推荐）**：动态汇总强相关视频的所有标签构建标签池，共享相关标签与别名的视频予以放行，**误杀率更低**。
  - **强关联（严格包含）**：严格要求标题、标签、作者或简介命中搜索关键词，排除分区分类名称泛化干扰，杜绝误放行。
- **零黑名单维护**：无需用户维护任何繁琐易过期的黑名单词库，杜绝词库误杀。
- **极简交互设计**：无额外图标干扰，通过油猴原生菜单即可一键无感切换模式与强度。

---

## 菜单设置项

安装脚本后，点击油猴插件图标即可随时切换模式：

- **展示模式**：
  - `模糊展示 - 点击切换为直接过滤`（当前默认：模糊展示）
  - `直接过滤 - 点击切换为模糊展示`
- **过滤强度**：
  - `弱关联（包含相关标签） - 点击切换为强关联`（当前默认：弱关联）
  - `强关联（严格包含） - 点击切换为弱关联`

---
