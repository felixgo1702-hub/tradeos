import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const html = readFileSync(new URL("../review-dashboard.html", import.meta.url), "utf8");

assert.match(html, /const minFloatValue = relaxed \? 2000000000 : 3000000000;/, "正式候选基础市值下限应为30亿");
assert.match(html, /const maxFloatValue = relaxed \? 50000000000 : 30000000000;/, "正式候选基础市值上限应为300亿");
assert.match(html, /stock\.floatValue >= 3000000000/, "正式候选快速过滤市值下限应为30亿");
assert.match(html, /stock\.floatValue <= 30000000000/, "正式候选快速过滤市值上限应为300亿");
assert.match(html, /scoreRange\(floatYi, 30, 300, 12\)/, "正式候选市值评分区间应为30-300亿");
assert.match(html, /A级/, "推荐结果应显示A级");
assert.match(html, /B级/, "推荐结果应显示B级");
assert.match(html, /C级/, "推荐结果应显示C级");
assert.match(html, /slice\(0, 2\)/, "10点最终买入名单应最多2只");
assert.match(html, /getConfirmationWindow/, "确认阶段应支持10点后或13点后窗口");
assert.match(html, /current\.volumeRatio >= 2/, "次日确认量比应不低于2.0");
assert.match(html, /getIntradayMacdStatus/, "次日确认应检查15分钟和60分钟MACD");
assert.doesNotMatch(html, /confirmPassed:[^\n]+aboveIntradayAvg/, "分时价站上分时均线不应作为硬通过条件");
assert.doesNotMatch(html, /current\.intradayMacdStrong === null \? aboveIntradayAvg/, "分钟MACD数据不足时不应退回分时均线硬条件");
assert.doesNotMatch(html, /按分时均线替代确认/, "分钟MACD数据不足时不应提示用分时均线替代确认");
assert.match(html, /getRecentLimitUp/, "近10天涨停应进入候选评分");
assert.match(html, /pullbackFromLimitUp <= 8/, "涨停后回调8%以内应进入评分");
assert.match(html, /Trading OS 版本：v2026\.06\.04-2/, "页面底部应显示当前版本");

console.log("selection rule checks passed");
