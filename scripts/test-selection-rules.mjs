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
assert.match(html, /slice\(0, 1\)/, "10点最终买入名单应最多1只");

console.log("selection rule checks passed");
