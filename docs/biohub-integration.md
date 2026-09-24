# Biohub 接入核查（2026-09-24）

## 已实现：先查已有记录，不自动重新预测

第二阶段提供 UniProt 编号或单条 FASTA 查询。`POST /api/structures/atlas` 接受 `accession`、`sequence`；同时提供时必须完全一致，不暗中截短或换序列。

- 服务端按官方约定计算标准化序列的 MD5，查询 Atlas；MD5 仅作标识，不作为安全校验。
- 查询固定设置 `fold_on_miss=false`，无重折叠、相似序列替代或付费推理。此接口不发送 Biohub API Key。
- 全序列、长度、摘要标识再次核对。PDB 必须有与输入一致的单链完整 CA 残基序列及有效坐标，否则隔离，不传入设计。
- 找不到记录、仅有记录无结构、结构核对失败、服务错误分别报告。缺失置信度保留 `null`，不填零或编造分数。
- SAE 功能特征仅作模型假设。原始区域坐标保存在报告，未经坐标语义确认不转成设计热点，不推断功能抑制效果。
- 报告可下载，带查询时间与来源；不把用户序列持久化到浏览器或共享缓存。序列摘要仍能关联已知序列，不能视为匿名化。
- Atlas 为 Alpha API，可能变动；失败时保留明确错误，不冒充成功。

`BIOHUB_API_KEY` 只在托管环境中保存为 Secret。当前仅显示是否配置，**尚未验证推理鉴权，也未启用云端预测**。本地密钥不复制到仓库。查询无需重启本机 GPU 服务。

## 实测与测试边界

2026-09-24 实际调用公开泛素 76 aa、GFP `P42212`（238 aa）及鸡溶菌酶 `P00698`（147 aa）记录。均找到精确序列，但本次只读单条接口均未返回 PDB 或置信度。GFP 的官方批量导出也仅含 FASTA。这证明查询可用，**不证明已有结构获取已成功，也不证明这些蛋白没有结构**。

本机网站预览的真实同源 API 已查询 GFP，返回 `record_only`。有 PDB 的下载与错配隔离用公开 1UBQ 文件进行模拟上游测试；这不是 Atlas 实际返回 1UBQ 的证据。

## 官方 binder notebook：可借鉴，不能用推理 Key 一键运行

审阅来源：Biohub/esm `main` 在核查时为 `43b4548b86762edfa747b07d5f440aad3c33acee`。

- [官方 notebook](https://github.com/Biohub/esm/blob/43b4548b86762edfa747b07d5f440aad3c33acee/cookbook/tutorials/binder_design.ipynb)
- [配套设计脚本](https://github.com/Biohub/esm/blob/43b4548b86762edfa747b07d5f440aad3c33acee/cookbook/tutorials/binder_design.py)

Notebook 调用 Modal 部署的 GPU 程序，另需 Modal 账号、令牌和预算。脚本默认 H100；其中一个配置的注释报告共享 ESMC 后仍用约 27 GiB 显存，这不是所有任务的最低需求，但足以说明不能假定单张 11 GiB 2080 Ti 能直接跑通。两张卡不自动合并显存。此次未安装、部署或执行设计脚本。

可借鉴的结构：保存每条任务与随机种子、保留设计轨迹、多模型评估、按完整序列去重及归并结果、输出序列和复合物。脚本支持显式目标热点；其编号对应输入序列，必须先建立截短体与原蛋白编号映射。

不要照搬 notebook 的等电点过滤、加权排序或固定交付数量作为通用成功标准；不同候选类型和用途要单独校准。模型分数不是实验亲和力，多评估器也不必然互相独立。当前 BinderOS 标准对照未通过的问题仍需解决。

下一步若接入该设计后端，先在非致病公开标准靶标做预算受限的单任务验证，再评估是否启用批量生成；保留人工位点确认和费用确认，不在 Atlas 无结构时自动发起云任务。

## 官方接口

- [Atlas API](https://www.biohub.ai/esm/protein/atlas/api-docs/api_reference.html)
- [Biohub 结构推理 API](https://forge.biohub.ai/api-reference/fold_all_atom)

已有结构查询、鉴权云端推理、Modal binder 设计是三套不同能力，不将其中一套成功宣称为另外两套已接通。
