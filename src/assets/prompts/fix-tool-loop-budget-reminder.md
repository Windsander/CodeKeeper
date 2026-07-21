注意：剩余步数已不多。请尽快收敛：如果修复主体已完成，优先验证已完成部分并调用 finish，不要开启新的修改点或新的文件分段；如果已完成修复并验证通过，调用 finish({ success: true, reason: "..." })；如果无法修复或需要 Reviewer 澄清，调用 finish({ success: false, reason: "..." })；不要继续无意义的探索。
