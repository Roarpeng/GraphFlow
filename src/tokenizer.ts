/**
 * GraphFlow 3.1 — Unified Bilingual Query Tokenizer, Pinyin/Synonym & Typo Engine (`src/tokenizer.ts`)
 *
 * Solves the 4 real-world Chinese & English code search challenges before retrieval:
 *  1. Word Segmentation (`segmentChinese` & `tokenizeEnglish`):
 *     - Bidirectional Maximum Matching (FMM + BMM) + V8 `Intl.Segmenter("zh-CN")`
 *     - English camelCase/snake_case splitting + morphological stemming (`stemEnglishWord`)
 *  2. Pinyin Bidirectional Indexing (`resolvePinyin` & `toPinyin`):
 *     - Queries in Pinyin (`"dingdan chaoshi"`, `"weixin zhifu"`) resolve to Chinese & English tokens.
 *     - Queries in Chinese (`"订单支付"`) emit Pinyin tokens (`"dingdan"`, `"zhifu"`) to match
 *       legacy Pinyin-named identifiers (`handleDingDanZhiFu`).
 *  3. Chinese Synonym & Near-Synonym Expansion (`CJK_SYNONYM_CLUSTERS`):
 *     - Bidirectional synonym clusters (`支付` <-> `付款/收款/结账`, `取消` <-> `作废/撤单/撤销`,
 *       `用户` <-> `客户/买家/会员/账号`, `校验` <-> `验证/验签/核对/检查`) so different Chinese
 *       wordings in queries vs. code comments always match.
 *  4. Homophone Typo Correction & Edit-Distance-1 Fuzzy Matching (`normalizeChineseTypos` & `isFuzzyTokenMatch`):
 *     - Corrects Chinese Pinyin IME homophone typos (`定单钞时取销` -> `订单超时取消`,
 *       `回掉验千` -> `回调验签`, `事物回滚` -> `事务回滚`, `登陆帐号` -> `登录账号`).
 *     - Tolerates 1-char English/Pinyin typos & transpositions (`cancle` -> `cancel`, `expried` -> `expired`).
 */

export interface EnglishTokenResult {
  /** Exact raw identifiers found in input (e.g. `resolveEfficiencyPolicy`) */
  exactIdentifiers: string[];
  /** Normalized lowercase sub-words (e.g. `["resolve", "efficiency", "policy"]`) */
  words: string[];
  /** Morphological stems (e.g. `["resolv", "efficiency", "policy"]`) */
  stems: string[];
}

export interface ChineseSegmentResult {
  /** Normalized & segmented Chinese words (with homophone typos corrected) */
  words: string[];
  /** Multi-word contiguous phrases preserved for exact comment boosting */
  phrases: string[];
}

export interface BilingualQueryPlan {
  rawQuery: string;
   normalizedQuery: string;
  exactIdentifiers: string[];
  /** Lowercase English + Pinyin words (from query, CJK->EN/Pinyin, and Pinyin->EN) */
  englishWords: string[];
  /** Morphological stems for fuzzy identifier matching */
  englishStems: string[];
  /** Segmented Chinese words + expanded Chinese synonyms + Pinyin/EN->CJK reverse words */
  chineseWords: string[];
  /** Contiguous Chinese phrases (>= 3 chars) for high-precision comment matching */
  chinesePhrases: string[];
  /** Whether the query explicitly asks for test/benchmark files */
  wantsTests: boolean;
}

const ENGLISH_STOP_WORDS = new Set([
  "in",
  "on",
  "at",
  "by",
  "to",
  "of",
  "as",
  "is",
  "be",
  "or",
  "an",
  "it",
  "do",
  "if",
  "no",
  "so",
  "up",
  "we",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "what",
  "where",
  "when",
  "which",
  "who",
  "how",
  "why",
  "can",
  "could",
  "would",
  "should",
  "will",
  "please",
  "help",
  "find",
  "show",
  "all",
  "any",
  "into",
  "about",
  "does",
  "code",
  "file",
  "files",
  "function",
  "functions",
  "method",
  "methods",
  "logic",
  "impl",
  "implementation",
]);

const CHINESE_STOP_WORDS = new Set([
  "如何",
  "怎么",
  "怎样",
  "哪里",
  "在哪",
  "什么",
  "哪些",
  "帮我",
  "请问",
  "一下",
  "关于",
  "相关",
  "逻辑",
  "处理",
  "实现",
  "代码",
  "函数",
  "方法",
  "模块",
  "文件",
  "功能",
  "问题",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "以及",
  "或者",
  "如果",
  "因为",
  "所以",
  "但是",
  "然后",
  "进行",
  "使用",
  "通过",
  "需要",
  "可以",
  "是否",
  "没有",
  "一个",
  "的",
  "了",
  "在",
  "是",
  "我",
  "你",
  "他",
  "她",
  "它",
  "和",
  "与",
  "或",
  "及",
  "中",
  "里",
  "上",
  "下",
  "把",
  "被",
  "让",
  "给",
  "对",
  "从",
  "到",
  "有",
  "都",
  "也",
  "就",
  "要",
  "会",
  "能",
  "吗",
  "呢",
  "吧",
  "啊",
]);

/**
 * Direct orthography & common IME typo normalization map (applied before segmentation).
 */
export const CHINESE_TYPO_NORMALIZATION: Record<string, string> = {
  "定单": "订单",
  "订但": "订单",
  "顶单": "订单",
  "钞时": "超时",
  "超是": "超时",
  "潮时": "超时",
  "取销": "取消",
  "曲消": "取消",
  "撤消": "撤销",
  "消毁": "销毁",
  "登陆": "登录",
  "登路": "登录",
  "帐号": "账号",
  "帐户": "账户",
  "密匙": "密钥",
  "秘室": "密钥",
  "回掉": "回调",
  "汇调": "回调",
  "验千": "验签",
  "验迁": "验签",
  "厌签": "验签",
  "缓寸": "缓存",
  "换存": "缓存",
  "竹册": "注册",
  "注测": "注册",
  "权县": "权限",
  "全限": "权限",
  "融断": "熔断",
  "容断": "熔断",
  "线流": "限流",
  "限留": "限流",
  "事物": "事务",
  "队例": "队列",
  "对列": "队列",
  "发松": "发送",
  "配制": "配置",
  "佩置": "配置",
  "jiansuo": "检索",
};

/**
 * Character-level Pinyin table covering domain terms and their common homophone characters.
 * Enables phonetic hashing (`toPinyin`) so arbitrary homophone typos in multi-char words
 * (e.g. "威信知付" -> "weixinzhifu" / "weixinzhifu") map back to canonical domain concepts.
 */
const CHAR_TO_PINYIN: Record<string, string> = {
  "配": "pei", "佩": "pei", "赔": "pei",
  "置": "zhi", "制": "zhi", "治": "zhi", "支": "zhi", "知": "zhi", "之": "zhi", "值": "zhi", "执": "zhi",
  "初": "chu", "出": "chu", "处": "chu", "触": "chu",
  "始": "shi", "是": "shi", "时": "shi", "事": "shi", "实": "shi", "失": "shi", "试": "shi", "式": "shi",
  "化": "hua", "话": "hua", "划": "hua",
  "安": "an", "按": "an",
  "装": "zhuang", "状": "zhuang",
  "卸": "xie", "写": "xie", "协": "xie",
  "载": "zai", "在": "zai", "再": "zai",
  "索": "suo", "锁": "suo", "所": "suo",
  "引": "yin", "隐": "yin", "音": "yin",
  "检": "jian", "减": "jian", "鉴": "jian", "件": "jian", "键": "jian", "建": "jian",
  "搜": "sou",
  "分": "fen", "份": "fen",
  "词": "ci", "次": "ci",
  "读": "du", "独": "du", "度": "du",
  "取": "qu", "曲": "qu", "去": "qu", "区": "qu",
  "查": "cha", "察": "cha", "插": "cha",
  "询": "xun", "循": "xun", "讯": "xun",
  "创": "chuang",
  "新": "xin", "信": "xin", "心": "xin",
  "增": "zeng",
  "修": "xiu",
  "改": "gai",
  "更": "geng",
  "删": "shan", "闪": "shan",
  "除": "chu",
  "清": "qing", "请": "qing", "情": "qing",
  "理": "li", "例": "li", "力": "li",
  "重": "chong", "虫": "chong",
  "命": "ming", "名": "ming", "明": "ming",
  "缓": "huan", "换": "huan", "环": "huan",
  "存": "cun", "寸": "cun",
  "预": "yu", "逾": "yu", "与": "yu", "语": "yu",
  "算": "suan",
  "测": "ce", "册": "ce", "策": "ce",
  "单": "dan", "但": "dan", "担": "dan",
  "基": "ji", "机": "ji", "计": "ji", "记": "ji", "级": "ji", "集": "ji",
  "准": "zhun",
  "压": "ya",
  "缩": "suo",
  "折": "zhe", "者": "zhe",
  "叠": "die",
  "骨": "gu", "故": "gu",
  "骼": "ge", "格": "ge", "个": "ge",
  "切": "qie",
  "片": "pian",
  "脱": "tuo",
  "水": "shui",
  "爆": "bao", "报": "bao", "保": "bao", "包": "bao",
  "炸": "zha",
  "半": "ban", "办": "ban", "版": "ban",
  "径": "jing", "静": "jing", "境": "jing",
  "调": "diao", "掉": "diao",
  "用": "yong", "拥": "yong", "永": "yong",
  "工": "gong", "公": "gong", "共": "gong", "功": "gong",
  "具": "ju", "据": "ju", "局": "ju",
  "宏": "hong", "红": "hong",
  "习": "xi", "息": "xi", "系": "xi",
  "惯": "guan", "关": "guan", "管": "guan",
  "挖": "wa",
  "掘": "jue", "决": "jue", "绝": "jue",
  "历": "li", "立": "li",
  "史": "shi",
  "耦": "ou",
  "合": "he", "核": "he", "和": "he",
  "熔": "rong", "融": "rong", "容": "rong",
  "断": "duan", "段": "duan", "端": "duan",
  "死": "si", "私": "si",
  "拦": "lan",
  "截": "jie", "结": "jie", "接": "jie", "解": "jie", "界": "jie",
  "钩": "gou", "沟": "gou",
  "子": "zi", "字": "zi", "自": "zi", "资": "zi",
  "回": "hui", "汇": "hui", "会": "hui", "毁": "hui", "恢": "hui",
  "守": "shou", "收": "shou", "手": "shou", "首": "shou",
  "卫": "wei", "微": "wei", "威": "wei", "未": "wei", "位": "wei", "为": "wei",
  "契": "qi", "期": "qi", "起": "qi", "器": "qi", "弃": "qi",
  "约": "yue", "越": "yue",
  "构": "gou",
  "体": "ti", "提": "ti", "替": "ti",
  "口": "kou", "扣": "kou",
  "参": "can", "残": "can",
  "数": "shu", "输": "shu", "属": "shu",
  "法": "fa", "发": "fa", "罚": "fa",
  "路": "lu", "录": "lu", "陆": "lu",
  "由": "you", "友": "you", "优": "you", "有": "you",
  "权": "quan", "全": "quan", "券": "quan",
  "限": "xian", "县": "xian", "线": "xian", "现": "xian",
  "认": "ren", "人": "ren", "任": "ren",
  "证": "zheng", "正": "zheng", "整": "zheng",
  "登": "deng", "等": "deng",
  "注": "zhu", "竹": "zhu", "主": "zhu", "助": "zhu",
  "户": "hu", "护": "hu", "互": "hu",
  "密": "mi", "秘": "mi",
  "码": "ma",
  "钥": "yao", "要": "yao", "药": "yao",
  "令": "ling", "零": "ling",
  "牌": "pai", "排": "pai",
  "订": "ding", "定": "ding", "顶": "ding",
  "付": "fu", "负": "fu", "复": "fu", "服": "fu", "符": "fu",
  "宝": "bao",
  "退": "tui", "推": "tui",
  "款": "kuan",
  "金": "jin", "进": "jin", "禁": "jin",
  "额": "e", "恶": "e",
  "价": "jia", "加": "jia", "假": "jia",
  "惠": "hui",
  "余": "yu",
  "库": "ku",
  "超": "chao", "钞": "chao", "潮": "chao",
  "过": "guo",
  "消": "xiao", "销": "xiao", "小": "xiao", "效": "xiao", "校": "xiao",
  "撤": "che",
  "作": "zuo", "座": "zuo", "做": "zuo",
  "废": "fei", "费": "fei", "非": "fei",
  "流": "liu", "留": "liu",
  "并": "bing",
  "务": "wu", "物": "wu", "无": "wu", "误": "wu",
  "滚": "gun",
  "队": "dui", "对": "dui",
  "列": "lie",
  "通": "tong", "同": "tong", "统": "tong",
  "验": "yan", "厌": "yan", "延": "yan", "严": "yan",
  "签": "qian", "千": "qian", "迁": "qian", "钱": "qian", "前": "qian",
  "哈": "ha",
  "希": "xi",
  "序": "xu", "续": "xu", "需": "xu",
  "传": "chuan", "串": "chuan",
  "导": "dao", "到": "dao", "道": "dao",
  "入": "ru",
  "页": "ye", "业": "ye",
  "滤": "lv", "率": "lv",
  "志": "zhi",
  "监": "jian",
  "控": "kong", "空": "kong",
  "告": "gao", "高": "gao",
  "警": "jing",
  "异": "yi", "已": "yi", "以": "yi", "依": "yi",
  "常": "chang", "长": "chang", "场": "chang",
  "错": "cuo",
  "败": "bai",
  "态": "tai", "太": "tai",
  "连": "lian", "链": "lian",
  "网": "wang", "往": "wang",
  "代": "dai", "带": "dai", "待": "dai",
  "动": "dong",
  "批": "pi",
  "量": "liang",
  "客": "ke", "可": "ke",
  "买": "mai", "卖": "mai",
  "家": "jia",
  "员": "yuan", "源": "yuan", "原": "yuan", "元": "yuan",
  "账": "zhang", "帐": "zhang", "障": "zhang",
  "号": "hao", "好": "hao",
  "迟": "chi", "池": "chi",
  "崩": "beng",
  "溃": "kui",
};

/**
 * Bidirectional Chinese synonym / near-synonym clusters.
 * Any word in a cluster automatically expands to all sibling Chinese words in that cluster
 * so queries using different Chinese phrasing than code comments still match directly.
 */
export const CJK_SYNONYM_CLUSTERS: string[][] = [
  ["支付", "付款", "收款", "结账", "缴费", "交费", "扣款"],
  ["取消", "作废", "撤单", "退单", "撤销", "关闭", "终止"],
  ["订单", "单据", "交易单", "采购单"],
  ["超时", "过期", "逾期", "延迟", "延时"],
  ["用户", "客户", "买家", "会员", "账号", "账户"],
  ["登录", "登入", "签到"],
  ["密码", "口令", "密钥", "秘钥"],
  ["令牌", "凭证", "凭据"],
  ["校验", "验证", "验签", "核对", "检查", "核验", "鉴权", "认证"],
  ["签名", "加签", "验签"],
  ["异常", "错误", "失败", "报错", "故障", "崩溃"],
  ["缓存", "暂存"],
  ["事务", "数据库"],
  ["回滚", "还原", "恢复", "撤销"],
  ["回调", "钩子", "通知"],
  ["删除", "移除", "清理", "清除", "销毁"],
  ["创建", "新增", "添加", "生成", "新建"],
  ["修改", "更新", "编辑", "变更", "改动"],
  ["查询", "检索", "搜索", "查找", "获取", "读取"],
  ["配置", "设置", "选项", "参数"],
  ["压缩", "折叠", "脱水", "精简"],
  ["熔断", "死循环", "限流"],
];

// Build fast lookup: Chinese word -> all Chinese synonyms in its cluster(s)
const CJK_TO_SYNONYMS = new Map<string, Set<string>>();
for (const cluster of CJK_SYNONYM_CLUSTERS) {
  for (const w of cluster) {
    let set = CJK_TO_SYNONYMS.get(w);
    if (!set) {
      set = new Set<string>();
      CJK_TO_SYNONYMS.set(w, set);
    }
    for (const peer of cluster) {
      set.add(peer);
    }
  }
}

export const CJK_ENGINEERING_GLOSSARY: Record<string, string[]> = {
  "配置": ["config", "configuration", "setting", "resolve", "schema", "defaults", "env", "option", "peizhi"],
  "设置": ["setting", "config", "option", "setup", "shezhi"],
  "初始化": ["init", "initialize", "setup", "bootstrap", "install", "chushihua"],
  "安装": ["install", "installer", "setup", "register", "anzhuang"],
  "卸载": ["uninstall", "remove", "clean", "xiezai"],
  "索引": ["index", "indexer", "ast", "parse", "symbol", "suoyin"],
  "检索": ["search", "query", "recall", "find", "locate", "slicer", "jiansuo"],
  "搜索": ["search", "query", "find", "lookup", "match", "sousuo"],
  "查找": ["find", "search", "lookup", "query", "locate", "chazhao"],
  "分词": ["tokenize", "tokenizer", "segment", "segmenter", "lexer", "fenci"],
  "读取": ["read", "load", "fetch", "get", "slice", "duqu"],
  "获取": ["get", "fetch", "acquire", "obtain", "read", "huoqu"],
  "查询": ["query", "find", "get", "fetch", "list", "search", "chaxun"],
  "创建": ["create", "add", "insert", "new", "build", "make", "chuangjian"],
  "新建": ["create", "new", "init", "make", "xinjian"],
  "新增": ["create", "add", "insert", "append", "xinzeng"],
  "添加": ["add", "append", "insert", "create", "tianjia"],
  "生成": ["generate", "create", "build", "produce", "shengcheng"],
  "修改": ["edit", "update", "modify", "patch", "surgical", "change", "xiugai"],
  "更新": ["update", "edit", "refresh", "sync", "patch", "gengxin"],
  "编辑": ["edit", "modify", "update", "bianji"],
  "删除": ["delete", "remove", "drop", "unset", "clean", "prune", "shanchu"],
  "移除": ["remove", "delete", "strip", "yichu"],
  "销毁": ["destroy", "dispose", "delete", "clean", "xiaohui"],
  "清理": ["clean", "clear", "prune", "purge", "gc", "reset", "qingli"],
  "重命名": ["rename", "refactor", "move", "symbol", "chongmingming"],
  "缓存": ["cache", "prefix", "store", "memo", "dedup", "sha256", "huancun"],
  "暂存": ["cache", "stash", "temp", "buffer", "zancun"],
  "去重": ["dedup", "deduplicate", "unique", "cache", "sha256", "quchong"],
  "预算": ["budget", "token", "pressure", "limit", "quota", "yusuan"],
  "测试": ["test", "affected", "vitest", "pytest", "spec", "bench", "assert", "ceshi"],
  "单测": ["test", "unit", "spec", "assert", "dance"],
  "基准": ["bench", "benchmark", "perf", "metric", "jizhun"],
  "压缩": ["compress", "slice", "skeleton", "dehydrate", "fold", "reduce", "yasuo"],
  "折叠": ["fold", "skeleton", "collapse", "outline", "zhedie"],
  "骨骼": ["skeleton", "fold", "outline", "ast", "guge"],
  "切片": ["slice", "slicer", "snippet", "surgical", "qiepian"],
  "脱水": ["dehydrate", "dehydrator", "compress", "stdout", "log", "tuoshui"],
  "爆炸半径": ["blast", "radius", "caller", "callsite", "importer", "baozhabanjing"],
  "调用": ["call", "caller", "invoke", "blast", "radius", "diaoyong"],
  "工具": ["tool", "mcp", "handler", "exec", "cli", "gongju"],
  "宏": ["macro", "trajectory", "workflow", "codemod", "template", "hong"],
  "习惯": ["habit", "macro", "trajectory", "coedit", "history", "xiguan"],
  "挖掘": ["mine", "miner", "git", "coupling", "cochange", "pattern", "wajue"],
  "历史": ["git", "history", "log", "commit", "cochange", "temporal", "lishi"],
  "耦合": ["coupling", "cochange", "coedit", "temporal", "git", "ouhe"],
  "熔断": ["circuit", "breaker", "thrash", "loop", "rescue", "rongduan"],
  "死循环": ["loop", "thrash", "circuit", "breaker", "retry", "sixunhuan"],
  "拦截": ["intercept", "interceptor", "hook", "pretool", "posttool", "guard", "lanjie"],
  "钩子": ["hook", "interceptor", "callback", "pretool", "posttool", "gouzi"],
  "回调": ["callback", "hook", "webhook", "notify", "handler", "huidiao"],
  "守卫": ["guard", "check", "verify", "validate", "contract", "arity", "shouwei"],
  "契约": ["contract", "struct", "interface", "field", "schema", "type", "qiyue"],
  "结构体": ["struct", "interface", "class", "record", "field", "type", "jiegouti"],
  "接口": ["interface", "api", "contract", "type", "endpoint", "jiekou"],
  "字段": ["field", "property", "prop", "member", "struct", "ziduan"],
  "参数": ["param", "arg", "arity", "argument", "option", "canshu"],
  "语法": ["syntax", "parse", "ast", "error", "guard", "yufa"],
  "路由": ["route", "router", "dispatch", "handler", "path", "luyou"],
  "权限": ["rbac", "security", "auth", "permission", "policy", "role", "quanxian"],
  "鉴权": ["auth", "authenticate", "authorize", "token", "jwt", "session", "jianquan"],
  "认证": ["auth", "verify", "login", "credential", "token", "renzheng"],
  "登录": ["login", "signin", "auth", "session", "user", "denglu"],
  "注册": ["register", "signup", "install", "enroll", "zhuce"],
  "用户": ["user", "account", "profile", "member", "client", "yonghu"],
  "客户": ["client", "customer", "user", "account", "kehu"],
  "买家": ["buyer", "user", "customer", "client", "maijia"],
  "会员": ["member", "vip", "user", "account", "huiyuan"],
  "账号": ["account", "user", "login", "profile", "zhanghao"],
  "账户": ["account", "wallet", "user", "balance", "zhanghu"],
  "密码": ["password", "secret", "credential", "hash", "salt", "mima"],
  "口令": ["password", "token", "passcode", "secret", "kouling"],
  "密钥": ["secret", "key", "private", "crypto", "token", "miyao"],
  "秘钥": ["secret", "key", "private", "crypto", "token", "miyao"],
  "令牌": ["token", "jwt", "auth", "refresh", "session", "lingpai"],
  "凭证": ["credential", "token", "cert", "auth", "pingzheng"],
  "会话": ["session", "context", "state", "token", "cookie", "huihua"],
  "订单": ["order", "checkout", "trade", "purchase", "cart", "dingdan"],
  "单据": ["order", "bill", "invoice", "receipt", "danju"],
  "支付": ["pay", "payment", "charge", "refund", "billing", "wechat", "alipay", "zhifu"],
  "付款": ["pay", "payment", "checkout", "charge", "billing", "fukuan"],
  "收款": ["pay", "payment", "receive", "collect", "charge", "shoukuan"],
  "结账": ["checkout", "pay", "settle", "billing", "jiezhang"],
  "微信": ["wechat", "wx", "pay", "callback", "notify", "weixin"],
  "支付宝": ["alipay", "pay", "payment", "callback", "zhifubao"],
  "退款": ["refund", "cancel", "return", "pay", "payment", "tuikuan"],
  "金额": ["amount", "price", "total", "cost", "fee", "money", "cent", "jine"],
  "价格": ["price", "amount", "cost", "rate", "quote", "jiage"],
  "折扣": ["discount", "coupon", "promo", "price", "rate", "zhekou"],
  "优惠券": ["coupon", "voucher", "discount", "promo", "youhuiquan"],
  "余额": ["balance", "wallet", "account", "credit", "fund", "yue"],
  "库存": ["stock", "inventory", "sku", "reserve", "deduct", "kucun"],
  "扣减": ["deduct", "decrease", "subtract", "reserve", "stock", "koujian"],
  "超时": ["timeout", "expired", "expire", "deadline", "ttl", "delay", "chaoshi"],
  "过期": ["expire", "expired", "ttl", "timeout", "stale", "guoqi"],
  "逾期": ["overdue", "expired", "expire", "timeout", "yuqi"],
  "延迟": ["delay", "latency", "timeout", "defer", "yanchi"],
  "取消": ["cancel", "abort", "revoke", "close", "stop", "quxiao"],
  "作废": ["cancel", "void", "invalidate", "revoke", "zuofei"],
  "撤单": ["cancel", "revoke", "abort", "order", "chedan"],
  "退单": ["cancel", "refund", "return", "order", "tuidan"],
  "撤销": ["revoke", "cancel", "undo", "revert", "rollback", "chexiao"],
  "关闭": ["close", "cancel", "shutdown", "stop", "guanbi"],
  "重试": ["retry", "backoff", "attempt", "recover", "chongshi"],
  "限流": ["limit", "rate", "throttle", "quota", "bucket", "xianliu"],
  "并发": ["concurrent", "parallel", "async", "lock", "mutex", "worker", "bingfa"],
  "锁": ["lock", "mutex", "semaphore", "atomic", "sync", "suo"],
  "数据库": ["db", "database", "sql", "store", "repo", "query", "shujuku"],
  "事务": ["tx", "transaction", "commit", "rollback", "atomic", "shiwu"],
  "回滚": ["rollback", "revert", "undo", "restore", "backup", "huigun"],
  "队列": ["queue", "mq", "job", "worker", "task", "consumer", "producer", "duilie"],
  "消息": ["message", "msg", "event", "notify", "pub", "sub", "xiaoxi"],
  "通知": ["notify", "notification", "alert", "message", "webhook", "tongzhi"],
  "校验": ["validate", "verify", "check", "assert", "guard", "schema", "jiaoyan"],
  "验证": ["verify", "validate", "check", "auth", "signature", "yanzheng"],
  "验签": ["verify", "signature", "sign", "hmac", "crypto", "webhook", "yanqian"],
  "核对": ["verify", "check", "validate", "reconcile", "signature", "hedui"],
  "检查": ["check", "inspect", "verify", "validate", "jiancha"],
  "签名": ["sign", "signature", "hmac", "hash", "crypto", "qianming"],
  "加密": ["encrypt", "cipher", "crypto", "aes", "rsa", "secret", "jiami"],
  "解密": ["decrypt", "decipher", "crypto", "aes", "jiemi"],
  "哈希": ["hash", "sha", "sha256", "md5", "digest", "fingerprint", "haxi"],
  "解析": ["parse", "parser", "ast", "extract", "decode", "resolve", "jiexi"],
  "序列化": ["serialize", "stringify", "json", "encode", "format", "xuliehua"],
  "格式化": ["format", "pretty", "render", "print", "display", "geshihua"],
  "上传": ["upload", "file", "multipart", "stream", "storage", "shangchuan"],
  "下载": ["download", "fetch", "export", "stream", "file", "xiazai"],
  "导出": ["export", "dump", "output", "download", "write", "daochu"],
  "导入": ["import", "load", "ingest", "parse", "read", "daoru"],
  "分页": ["page", "pagination", "offset", "limit", "cursor", "fenye"],
  "排序": ["sort", "order", "rank", "score", "compare", "paixu"],
  "过滤": ["filter", "where", "match", "exclude", "include", "guolv"],
  "计算": ["calc", "calculate", "compute", "count", "sum", "score", "jisuan"],
  "统计": ["stat", "metrics", "count", "summary", "report", "aggregate", "tongji"],
  "日志": ["log", "logger", "trace", "debug", "audit", "record", "rizhi"],
  "监控": ["monitor", "metric", "health", "trace", "watch", "jiankong"],
  "告警": ["alert", "alarm", "warn", "warning", "notify", "gaojing"],
  "异常": ["error", "exception", "fail", "catch", "fault", "panic", "yichang"],
  "错误": ["error", "err", "fail", "invalid", "reject", "cuowu"],
  "失败": ["fail", "failed", "failure", "error", "reject", "shibai"],
  "报错": ["error", "exception", "fail", "throw", "baocuo"],
  "故障": ["fault", "failure", "error", "outage", "guzhang"],
  "崩溃": ["crash", "panic", "fatal", "error", "bengkui"],
  "状态": ["state", "status", "phase", "mode", "health", "zhuangtai"],
  "定时": ["cron", "schedule", "timer", "interval", "job", "dingshi"],
  "调度": ["schedule", "scheduler", "dispatch", "orchestrate", "queue", "diaodu"],
  "连接": ["connect", "connection", "conn", "client", "pool", "socket", "lianjie"],
  "网关": ["gateway", "proxy", "router", "ingress", "edge", "wangguan"],
  "代理": ["proxy", "agent", "forward", "gateway", "client", "daili"],
  "自动": ["auto", "automatic", "cron", "batch", "zidong"],
  "批量": ["batch", "bulk", "multi", "all", "piliang"],
};

/**
 * Convert a Chinese word into its concatenated Pinyin phonetic key (e.g. `"订单"` -> `"dingdan"`, `"定单"` -> `"dingdan"`).
 * Returns undefined if any character is not in CHAR_TO_PINYIN.
 */
export function toPinyin(cjkWord: string): string | undefined {
  if (!cjkWord || cjkWord.length < 2) return undefined;
  let out = "";
  for (const ch of cjkWord) {
    const py = CHAR_TO_PINYIN[ch];
    if (!py) return undefined;
    out += py;
  }
  return out;
}

// Build reverse English/Pinyin -> Chinese lookup table AND Pinyin -> canonical Chinese word table
const REVERSE_EN_OR_PINYIN_TO_CJK = new Map<string, Set<string>>();
const PINYIN_TO_CANONICAL_CJK = new Map<string, string[]>();

for (const [cn, enList] of Object.entries(CJK_ENGINEERING_GLOSSARY)) {
  const py = toPinyin(cn);
  if (py) {
    const existing = PINYIN_TO_CANONICAL_CJK.get(py) ?? [];
    if (!existing.includes(cn)) existing.push(cn);
    PINYIN_TO_CANONICAL_CJK.set(py, existing);

    let pySet = REVERSE_EN_OR_PINYIN_TO_CJK.get(py);
    if (!pySet) {
      pySet = new Set<string>();
      REVERSE_EN_OR_PINYIN_TO_CJK.set(py, pySet);
    }
    pySet.add(cn);
  }

  for (const en of enList) {
    const key = en.toLowerCase();
    let set = REVERSE_EN_OR_PINYIN_TO_CJK.get(key);
    if (!set) {
      set = new Set<string>();
      REVERSE_EN_OR_PINYIN_TO_CJK.set(key, set);
    }
    set.add(cn);
  }
}

const CJK_LEXICON_SET = new Set<string>(Object.keys(CJK_ENGINEERING_GLOSSARY));
for (const cluster of CJK_SYNONYM_CLUSTERS) {
  for (const w of cluster) CJK_LEXICON_SET.add(w);
}
const MAX_CJK_WORD_LEN = Math.max(
  4,
  ...Array.from(CJK_LEXICON_SET).map((w) => w.length)
);

/**
 * Corrects common Chinese IME typos and homophone typos in a raw query string.
 *  1. Direct dictionary replacement (`CHINESE_TYPO_NORMALIZATION`: e.g. `定单` -> `订单`, `撤消` -> `撤销`).
 *  2. Phonetic 2-char sliding window homophone correction via `PINYIN_TO_CANONICAL_CJK`
 *     (e.g. `威信` -> `weixin` -> `微信`, `知付` -> `zhifu` -> `支付`).
 */
export function normalizeChineseTypos(text: string): string {
  let normalized = text;
  for (const [typo, right] of Object.entries(CHINESE_TYPO_NORMALIZATION)) {
    if (normalized.includes(typo)) {
      normalized = normalized.split(typo).join(right);
    }
  }

  // Phonetic homophone normalization on contiguous CJK runs
  normalized = normalized.replace(/[\u4e00-\u9fff]{2,}/g, (seq) => {
    const chars = Array.from(seq);
    let i = 0;
    let out = "";
    while (i < chars.length) {
      if (i + 1 < chars.length) {
        const pair = chars[i]! + chars[i + 1]!;
        if (CJK_LEXICON_SET.has(pair) || CHINESE_STOP_WORDS.has(pair)) {
          out += pair;
          i += 2;
          continue;
        }
        const py = toPinyin(pair);
        const canonical = py ? PINYIN_TO_CANONICAL_CJK.get(py)?.[0] : undefined;
        if (canonical) {
          out += canonical;
          i += 2;
          continue;
        }
      }
      out += chars[i]!;
      i += 1;
    }
    return out;
  });

  return normalized;
}

/**
 * Damerau-Levenshtein edit distance <= 1 check (1-char insertion, deletion, substitution,
 * or adjacent character transposition like `cancle` <-> `cancel`, `expried` <-> `expired`).
 * Only enabled for tokens of length >= 4 with matching first character to prevent false positives.
 */
export function isFuzzyTokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a[0] !== b[0]) return false;
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > 1) return false;

  // Same length: either 1 substitution OR 1 adjacent transposition (`cancle` vs `cancel`)
  if (a.length === b.length) {
    let diffs = 0;
    let firstDiff = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        diffs += 1;
        if (diffs === 1) firstDiff = i;
        else if (diffs === 2) {
          // Check adjacent transposition
          if (firstDiff + 1 !== i || a[firstDiff] !== b[i] || a[i] !== b[firstDiff]) {
            return false;
          }
        } else {
          return false;
        }
      }
    }
    return diffs === 1 || diffs === 2;
  }

  // Length differs by 1: 1 insertion / deletion (`ordrs` vs `orders`)
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let si = 0;
  let li = 0;
  let skipped = false;
  while (si < shorter.length && li < longer.length) {
    if (shorter[si] === longer[li]) {
      si += 1;
      li += 1;
    } else {
      if (skipped) return false;
      skipped = true;
      li += 1;
    }
  }
  return true;
}

/**
 * Lightweight zero-dependency English morphological stemmer + common typo normalizer.
 */
export function stemEnglishWord(word: string): string {
  let w = word.toLowerCase().trim();
  if (w.length <= 3) return w;

  // Resolve 1-char typo against known canonical vocabulary if exact match not found
  for (const known of REVERSE_EN_OR_PINYIN_TO_CJK.keys()) {
    if (known.length >= 5 && isFuzzyTokenMatch(w, known)) {
      w = known;
      break;
    }
  }

  const irregulars: Record<string, string> = {
    authentication: "auth",
    authenticate: "auth",
    authenticated: "auth",
    authorization: "auth",
    authorize: "auth",
    authorized: "auth",
    configuration: "config",
    configure: "config",
    configured: "config",
    cancellation: "cancel",
    cancelled: "cancel",
    canceling: "cancel",
    canceled: "cancel",
    cancle: "cancel",
    expiration: "expir",
    expired: "expir",
    expiring: "expir",
    expires: "expir",
    expire: "expir",
    expried: "expir",
    validation: "valid",
    validator: "valid",
    validate: "valid",
    validated: "valid",
    verification: "verifi",
    verified: "verifi",
    verifier: "verifi",
    verify: "verifi",
    connection: "connect",
    connected: "connect",
    connecting: "connect",
    execution: "exec",
    execute: "exec",
    executed: "exec",
    executing: "exec",
    compression: "compress",
    compressed: "compress",
    dehydration: "dehydr",
    dehydrate: "dehydr",
    dehydrated: "dehydr",
    dehydrator: "dehydr",
    encryption: "encrypt",
    encrypted: "encrypt",
    decryption: "decrypt",
    decrypted: "decrypt",
    transaction: "tx",
    transactions: "tx",
    repository: "repo",
    repositories: "repo",
    initialize: "init",
    initialized: "init",
    initialization: "init",
    signature: "sign",
    signatures: "sign",
    signed: "sign",
    signing: "sign",
    payment: "pay",
    payments: "pay",
    paid: "pay",
    paying: "pay",
  };
  if (irregulars[w]) return irregulars[w]!;

  const suffixes = [
    "izations",
    "ization",
    "ational",
    "fulness",
    "ousness",
    "iveness",
    "ements",
    "ement",
    "ations",
    "ation",
    "ances",
    "ance",
    "ences",
    "ence",
    "ings",
    "ing",
    "ions",
    "ion",
    "able",
    "ible",
    "ness",
    "less",
    "ment",
    "ities",
    "ity",
    "ies",
    "ied",
    "ed",
    "es",
    "s",
  ];

  for (const suf of suffixes) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      if (suf === "s" && (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is"))) {
        continue;
      }
      if (suf === "ies" || suf === "ied") {
        w = `${w.slice(0, -3)}y`;
      } else {
        w = w.slice(0, -suf.length);
      }
      break;
    }
  }

  if (w.length >= 4 && w[w.length - 1] === w[w.length - 2] && !"lsz".includes(w[w.length - 1]!)) {
    w = w.slice(0, -1);
  }
  if (w.endsWith("e") && w.length >= 5) {
    w = w.slice(0, -1);
  }
  return w;
}

/**
 * Dedicated English & Pinyin tokenizer: splits camelCase, PascalCase, snake_case,
 * kebab-case, dot.paths, and UPPER_ACRONYMS, then computes morphological stems.
 */
export function tokenizeEnglish(text: string): EnglishTokenResult {
  const exactIdentifiers: string[] = [];
  const words = new Set<string>();
  const stems = new Set<string>();

  for (const m of text.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$/.:-]{1,}/g)) {
    const raw = m[0];
    if (raw.length >= 2 && !ENGLISH_STOP_WORDS.has(raw.toLowerCase())) {
      exactIdentifiers.push(raw);
    }
    const parts = raw
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .map((s) => s.toLowerCase())
      .filter((s) => s.length >= 2 && !ENGLISH_STOP_WORDS.has(s));

    for (const p of parts) {
      words.add(p);
      // Resolve fuzzy 1-char typo if matching a known domain word
      for (const known of REVERSE_EN_OR_PINYIN_TO_CJK.keys()) {
        if (known.length >= 5 && isFuzzyTokenMatch(p, known)) {
          words.add(known);
        }
      }
      const stem = stemEnglishWord(p);
      if (stem.length >= 2) stems.add(stem);
    }
  }

  return {
    exactIdentifiers,
    words: Array.from(words),
    stems: Array.from(stems),
  };
}

function fmmSegment(chunk: string, dict: ReadonlySet<string>, maxLen: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    let matched = "";
    const endLimit = Math.min(chunk.length, i + maxLen);
    for (let end = endLimit; end > i + 1; end--) {
      const sub = chunk.slice(i, end);
      if (dict.has(sub)) {
        matched = sub;
        break;
      }
    }
    if (matched) {
      out.push(matched);
      i += matched.length;
    } else {
      out.push(chunk[i]!);
      i += 1;
    }
  }
  return out;
}

function bmmSegment(chunk: string, dict: ReadonlySet<string>, maxLen: number): string[] {
  const out: string[] = [];
  let j = chunk.length;
  while (j > 0) {
    let matched = "";
    const startLimit = Math.max(0, j - maxLen);
    for (let start = startLimit; start < j - 1; start++) {
      const sub = chunk.slice(start, j);
      if (dict.has(sub)) {
        matched = sub;
        break;
      }
    }
    if (matched) {
      out.unshift(matched);
      j -= matched.length;
    } else {
      out.unshift(chunk[j - 1]!);
      j -= 1;
    }
  }
  return out;
}

let cachedIntlSegmenter: Intl.Segmenter | null | undefined;
function getIntlSegmenter(): Intl.Segmenter | null {
  if (cachedIntlSegmenter !== undefined) return cachedIntlSegmenter;
  try {
    cachedIntlSegmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter("zh-CN", { granularity: "word" })
        : null;
  } catch {
    cachedIntlSegmenter = null;
  }
  return cachedIntlSegmenter;
}

/**
 * Dedicated Chinese word segmenter:
 *  1. Normalizes IME & homophone typos (`normalizeChineseTypos`).
 *  2. Combines V8 ICU `Intl.Segmenter("zh-CN", { granularity: "word" })` with
 *     Bidirectional Maximum Matching (FMM + BMM) over the engineering lexicon.
 *  3. Removes Chinese conversational stop words first so no cross-boundary
 *     garbage bigrams are produced.
 */
export function segmentChinese(text: string): ChineseSegmentResult {
  const normalizedText = normalizeChineseTypos(text);
  const words = new Set<string>();
  const phrases = new Set<string>();
  const intlSeg = getIntlSegmenter();

  for (const m of normalizedText.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const rawSeq = m[0];
    if (rawSeq.length >= 3 && !CHINESE_STOP_WORDS.has(rawSeq)) {
      phrases.add(rawSeq);
    }

    const dynamicDict = new Set<string>(CJK_LEXICON_SET);
    for (const sw of CHINESE_STOP_WORDS) {
      if (sw.length >= 2) dynamicDict.add(sw);
    }
    if (intlSeg) {
      for (const item of intlSeg.segment(rawSeq)) {
        if (item.isWordLike && item.segment.length >= 2) {
          dynamicDict.add(item.segment);
        }
      }
    }

    const fmm = fmmSegment(rawSeq, dynamicDict, MAX_CJK_WORD_LEN);
    const bmm = bmmSegment(rawSeq, dynamicDict, MAX_CJK_WORD_LEN);
    const fmmSingles = fmm.filter((t) => t.length === 1).length;
    const bmmSingles = bmm.filter((t) => t.length === 1).length;
    const chosen = bmmSingles <= fmmSingles ? bmm : fmm;

    let singleBuf = "";
    const flushSingleBuf = () => {
      if (singleBuf.length >= 2) {
        const py = toPinyin(singleBuf);
        const canonical = py ? PINYIN_TO_CANONICAL_CJK.get(py)?.[0] : undefined;
        words.add(canonical ?? singleBuf);
      }
      singleBuf = "";
    };

    for (const token of chosen) {
      if (CHINESE_STOP_WORDS.has(token)) {
        flushSingleBuf();
        continue;
      }
      if (token.length === 1) {
        singleBuf += token;
      } else {
        flushSingleBuf();
        words.add(token);
      }
    }
    flushSingleBuf();
  }

  return {
    words: Array.from(words),
    phrases: Array.from(phrases),
  };
}

/**
 * Unified Bilingual Query Tokenizer (`tokenizeBilingualQuery`):
 *  1. Normalizes Chinese homophone typos (`定单钞时` -> `订单超时`) and English 1-char typos (`cancle` -> `cancel`).
 *  2. Segments Chinese (`segmentChinese`) and English/Pinyin (`tokenizeEnglish`).
 *  3. Expands Chinese synonyms (`CJK_SYNONYM_CLUSTERS`: `付款` <-> `支付`, `核对` <-> `验签`).
 *  4. Expands bidirectionally across Chinese <-> English <-> Pinyin (`dingdan` <-> `订单` <-> `order`).
 */
export function tokenizeBilingualQuery(query: string): BilingualQueryPlan {
  const normalizedQuery = normalizeChineseTypos(query);
  const en = tokenizeEnglish(normalizedQuery);
  const zh = segmentChinese(normalizedQuery);

  const englishWords = new Set<string>(en.words);
  const englishStems = new Set<string>(en.stems);
  const chineseWords = new Set<string>(zh.words);

  // 1. Reverse expansion first: English OR Pinyin word -> Chinese domain words (e.g. "dingdan" -> "订单", "wechat" -> "微信")
  for (const ew of [...en.words, ...en.stems]) {
    const mappedCjk = REVERSE_EN_OR_PINYIN_TO_CJK.get(ew);
    if (mappedCjk) {
      for (const zw of mappedCjk) chineseWords.add(zw);
    }
  }

  // 2. Chinese Synonym Cluster expansion (`付款` -> `支付`, `核对` -> `验签/校验/签名`)
  for (const zw of Array.from(chineseWords)) {
    const syns = CJK_TO_SYNONYMS.get(zw);
    if (syns) {
      for (const peer of syns) chineseWords.add(peer);
    }
  }

  // 3. Forward expansion: All Chinese words (including expanded synonyms & Pinyin-resolved words) -> English + Pinyin tokens
  for (const zw of chineseWords) {
    const py = toPinyin(zw);
    if (py) {
      englishWords.add(py);
      englishStems.add(py);
    }
    const mapped = CJK_ENGINEERING_GLOSSARY[zw];
    if (mapped) {
      for (const ew of mapped) {
        const lower = ew.toLowerCase();
        englishWords.add(lower);
        englishStems.add(stemEnglishWord(lower));
      }
    }
  }

  const wantsTests =
    /test|bench|spec/i.test(normalizedQuery) ||
    chineseWords.has("测试") ||
    chineseWords.has("单测") ||
    chineseWords.has("基准");

  return {
    rawQuery: query,
    normalizedQuery,
    exactIdentifiers: en.exactIdentifiers,
    englishWords: Array.from(englishWords),
    englishStems: Array.from(englishStems),
    chineseWords: Array.from(chineseWords),
    chinesePhrases: zh.phrases,
    wantsTests,
  };
}
