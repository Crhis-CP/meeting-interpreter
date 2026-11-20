# 翻译准确度与速度实测

测试日期：2026-11-20。48 句常见商务会议用语，四个方向各 12 句：中→西、西→中（含阿根廷口语）、中→英、英→中。
句子在 [`scripts/dev/bench-cases.json`](../scripts/dev/bench-cases.json)，大模型那一组可以用 [`scripts/dev/bench-zhipu.mts`](../scripts/dev/bench-zhipu.mts) 自己重跑。

- **离线翻译**：本软件内置的免费离线翻译（Mozilla 模型），在普通电脑的浏览器内核里运行。
- **大模型**：智谱 GLM-4.7-Flash（免费），走本软件自己的翻译代码，一句一句地发。
- **评分**：逐句人工检查。✓ 意思完全正确；△ 能看懂，但有小错或不通顺；✗ 意思错了。

## 结果

| | 离线翻译（免费、无需 Key） | 智谱大模型（免费 Key） |
|---|---|---|
| 每句耗时（中位数） | **0.06 秒** | 0.9 秒 |
| 最慢一句 | 0.1 秒（首句加载约 0.5 秒） | 2.9 秒 |
| ✓ 完全正确 | 32 / 48（67%） | 44 / 48（92%） |
| ✓ + △ 能看懂 | 44 / 48（92%） | 48 / 48（100%） |
| ✗ 意思错 | 4 句 | 0 句 |

分方向（✓ / △ / ✗）：

| 方向 | 离线翻译 | 智谱大模型 |
|---|---|---|
| 中→西 | 8 / 3 / 1 | 11 / 1 / 0 |
| 西→中 | 7 / 3 / 2 | 10 / 2 / 0 |
| 中→英 | 8 / 3 / 1 | 12 / 0 / 0 |
| 英→中 | 9 / 3 / 0 | 11 / 1 / 0 |

大模型的速度和当时的网络、服务器繁忙程度有关：这次每句约 1 秒；之前测试时遇到过限流，单句要等好几秒。

## 离线翻译典型错误

- “这个方案你们觉得怎么样？” → “¿Qué te parece este *programa*?”（“方案”应为 propuesta / plan）
- “质量问题我们负责免费更换。” → 意思乱了
- “Necesitamos la factura antes de que llegue la mercadería…” → “我们需要……之前*支付账单*”（应为“拿到发票”）
- “¿El producto tiene certificación para vender en Argentina?” → 漏掉了“认证”
- “…el flete hasta Buenos Aires” → “*飞往*布宜诺斯艾利斯的运费”

这些错误在两段式翻译里会被大模型的正式译文替换掉；只用离线翻译时，可以把常用词加进术语表（例如 方案 → propuesta、flete → 运费），之后都会按你的写法翻。

## 阿根廷口语

离线模型本身能看懂 vos 的变位（tenés、querés、podés），但会把几个常用口头语翻错，例如 Che → “切”、Dale → “戴尔”、Bárbaro → “巴巴鲁斯”、Nos parece bien → “我们很好”。
现在离线翻译前会先把这些说法换成标准西语（Che 去掉；Dale → De acuerdo；Listo → Bien；Bárbaro → Genial；Ojo → Atención；re caro → muy caro；¿viste? 去掉；me/nos parece bien → estoy/estamos de acuerdo；laburo → trabajo；me pasás → me das），这几句就都翻对了。只在这些词单独作口头语时才换，“Dale el catálogo a Juan”“El pedido está listo”这类正常用法不动。

## 结论

- **离线翻译**很快（几乎是说完就出），大意基本都对，适合免费使用、断网使用，以及作为“先出的草稿”。
- **大模型**更准、更自然，但每句要等约 1 秒，网络不好时更久。
- 两样都有时（填了 Key 又下载了离线翻译），软件会先显示离线草稿（灰色斜体），大模型译文到了再替换；大模型超过 8 秒没回或出错，就直接用离线译文。
