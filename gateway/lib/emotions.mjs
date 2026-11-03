// 情绪预设：让"这句凶、那句软"成为可能，而音色始终是同一个 voice_id。
//
// 两条腿，缺一不可（2026-11-02 实测结论，见 docs/SPEAK.md「情绪」一节）：
//   ① instructions —— 只写"表演方式"（语气/情绪），**绝不写性别/年龄/嗓子粗细**。
//      写了那些词，云端会顺着描述重新设计音色，实测音色相似度掉到 0.71（换人）。
//   ② use_speaker_boost —— 让模型把结果往参考音色（voice_id）上贴。
//      实测：训人指令 0.91~0.97 → 加 boost 后 0.99，回到"同一配置重复生成"的自然波动里。
//      注意：官方文档说 guidance_scale > 1 时 boost 会被忽略，所以开了 boost 就不再传 guidance。
//   ③ filter —— 合成后的 ffmpeg 加工（响度/压缩/语速/EQ）。
//      instructions 改的是"发声方式"，加工补的是"响度和节奏"，两者不重复。
//      atempo 是保音高的速度倍率，不会把嗓子拉细或变粗。
//
// 全部字段都可在 config.say.emotions 里按情绪覆盖，不用改代码。

export const DEFAULT_EMOTIONS = {
  neutral: {
    label: '默认',
    instructions: '',
    filter: ''
  },
  sajiao: {
    label: '撒娇',
    instructions: '语气撒娇，声音软软的，拖长音。',
    // 拖慢 + 轻压缩（别把软糯压没了）+ 一点点亮
    filter: 'atempo=0.95,acompressor=threshold=-18dB:ratio=2.5:attack=8:release=150:makeup=1'
      + ',equalizer=f=2500:t=q:w=1.5:g=1.5,alimiter=limit=0.95'
  },
  angry: {
    label: '生气',
    instructions: '语气很凶，正在训人。',
    // 提速 + 重压缩（硬）+ 低频厚度 + 临场感
    filter: 'atempo=1.12,acompressor=threshold=-20dB:ratio=5:attack=4:release=100:makeup=2'
      + ',equalizer=f=180:t=q:w=1.2:g=3.5,equalizer=f=3500:t=q:w=1.5:g=2.5,alimiter=limit=0.95'
  },
  happy: {
    label: '高兴',
    instructions: '语气高兴，很兴奋，语速轻快。',
    filter: 'atempo=1.06,acompressor=threshold=-18dB:ratio=3:attack=6:release=120:makeup=1.5'
      + ',equalizer=f=4000:t=q:w=1.5:g=2,alimiter=limit=0.95'
  },
  wronged: {
    label: '委屈',
    instructions: '语气委屈，快哭了，声音很小。',
    // 故意不压缩：压缩会把"小声"抬上来，委屈感就没了
    filter: 'atempo=0.94,equalizer=f=300:t=q:w=1.2:g=-1.5,alimiter=limit=0.95'
  },
  gentle: {
    label: '温柔',
    instructions: '语气温柔，很耐心，语速放慢。',
    filter: 'atempo=0.96,equalizer=f=3500:t=q:w=1.5:g=-1,alimiter=limit=0.95'
  },
  impatient: {
    label: '不耐烦',
    instructions: '语气不耐烦，有点烦躁。',
    filter: 'atempo=1.08,acompressor=threshold=-20dB:ratio=3.5:attack=5:release=110:makeup=1.5'
      + ',equalizer=f=200:t=q:w=1.2:g=1.5,alimiter=limit=0.95'
  },
  surprise: {
    label: '惊讶',
    instructions: '语气惊讶，很吃惊。',
    filter: 'atempo=1.05,acompressor=threshold=-18dB:ratio=3:attack=3:release=100:makeup=1.5,alimiter=limit=0.95'
  },
  excited: {
    label: '兴奋',
    instructions: '语气兴奋，情绪高涨。',
    filter: 'atempo=1.1,acompressor=threshold=-18dB:ratio=3.5:attack=4:release=100:makeup=2'
      + ',equalizer=f=3000:t=q:w=1.5:g=2,alimiter=limit=0.95'
  },
  sad: {
    label: '难过',
    instructions: '语气难过，情绪低落。',
    filter: 'atempo=0.93,equalizer=f=3000:t=q:w=1.5:g=-1.5,alimiter=limit=0.95'
  }
};

/** 中文/口语别名 → 预设 id。模型写【凶】或【生气】都能认。 */
export const EMOTION_ALIASES = {
  默认: 'neutral', 正常: 'neutral', 平静: 'neutral', 普通: 'neutral',
  撒娇: 'sajiao', 软: 'sajiao', 卖萌: 'sajiao', 害羞: 'sajiao',
  生气: 'angry', 凶: 'angry', 愤怒: 'angry', 发火: 'angry', 训人: 'angry', 凶一点: 'angry',
  高兴: 'happy', 开心: 'happy', 快乐: 'happy',
  委屈: 'wronged', 哭: 'wronged', 难过哭腔: 'wronged', 想哭: 'wronged',
  温柔: 'gentle', 轻声: 'gentle', 哄人: 'gentle',
  不耐烦: 'impatient', 烦躁: 'impatient', 嫌弃: 'impatient',
  惊讶: 'surprise', 吃惊: 'surprise', 震惊: 'surprise',
  兴奋: 'excited', 激动: 'excited', 俏皮: 'excited', 得意: 'excited',
  难过: 'sad', 伤心: 'sad', 失落: 'sad', 累: 'sad', 疲惫: 'sad', 困: 'sad',
  认真: 'neutral', 严肃: 'neutral',

  // ── 宿主 send_voice 的 emotion 枚举（英文）直通 ──────────────────────────
  // QQA 的 send_voice 允许 neutral/happy/sad/angry/soft/excited/tired/shy/playful/serious，
  // 下面把网关没有同名预设的几个映射过去（其余同名，resolveEmotionKey 会直接命中 id）。
  soft: 'gentle',        // 温柔/哄人
  shy: 'sajiao',         // 害羞≈撒娇
  playful: 'excited',    // 俏皮/打趣
  tired: 'sad',          // 累了：放慢、压低、发闷
  serious: 'neutral'     // 认真：不加情绪修饰
};

/** 合并用户覆盖：只覆盖给了的字段，其余沿用默认。传 false 表示删掉这个情绪。 */
export function mergeEmotions(overrides) {
  const out = { ...DEFAULT_EMOTIONS };
  if (!overrides || typeof overrides !== 'object') return out;
  for (const [rawKey, value] of Object.entries(overrides)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    if (value === false) { delete out[key]; continue; }
    if (!value || typeof value !== 'object') continue;
    const base = out[key] && typeof out[key] === 'object' ? out[key] : { label: key, instructions: '', filter: '' };
    out[key] = {
      label: typeof value.label === 'string' ? value.label : base.label,
      instructions: typeof value.instructions === 'string' ? value.instructions : base.instructions,
      filter: typeof value.filter === 'string' ? value.filter : base.filter,
      // boost 默认开：它就是"音色不跑"的保险
      boost: value.boost === false ? false : (base.boost === false ? false : true)
    };
  }
  return out;
}

/** 名字（id 或中文别名）→ 预设 id；认不出返回空串。 */
export function resolveEmotionKey(name, table = DEFAULT_EMOTIONS) {
  const key = String(name ?? '').trim();
  if (!key) return '';
  if (table[key]) return key;
  const aliased = EMOTION_ALIASES[key];
  if (aliased && table[aliased]) return aliased;
  // 大小写不敏感（模型可能写 Angry）
  const lower = key.toLowerCase();
  const hit = Object.keys(table).find((k) => k.toLowerCase() === lower);
  return hit || '';
}

/**
 * 从台词里剥出开头的情绪标记：【生气】/ [生气] / （生气）/ (angry)，后面可带冒号。
 * 只认表里存在的名字 —— 否则「【重要】三点开会」这种正常方括号会被吃掉。
 */
const TAG_RE = /^\s*[【\[（(]\s*([^】\]）)\n]{1,10}?)\s*[】\]）)]\s*[:：,，、]?[ \t]*/;

export function parseEmotionTag(text, table = DEFAULT_EMOTIONS) {
  const raw = String(text ?? '');
  const match = TAG_RE.exec(raw);
  if (!match) return { emotion: '', text: raw, tagged: false };
  // 【生气：】这种冒号写在括号里的写法也认
  const label = String(match[1]).replace(/[:：,，、\s]+$/, '');
  const key = resolveEmotionKey(label, table);
  if (!key) return { emotion: '', text: raw, tagged: false };
  const rest = raw.slice(match[0].length);
  if (!rest.trim()) return { emotion: '', text: raw, tagged: false };   // 只有标记没有说话内容 → 不动
  return { emotion: key, text: rest, tagged: true };
}

/** 基础音色描述 + 情绪短句。基础描述保持原样，音色锚点才稳。 */
export function emotionInstruction(base, preset) {
  const anchor = String(base ?? '').trim().replace(/[。.\s]+$/, '');
  const clause = String(preset?.instructions ?? '').trim();
  if (!clause) return base;
  return anchor ? `${anchor}。${clause}` : clause;
}

/** 给文档/状态接口用：[{ id, label, hasFilter }]。 */
export function emotionList(table = DEFAULT_EMOTIONS) {
  return Object.entries(table).map(([id, preset]) => ({
    id,
    label: preset.label || id,
    instructions: preset.instructions || '',
    filter: preset.filter || ''
  }));
}
