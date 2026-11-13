'use strict';

// Source-specific conversion stays outside the screens. Screens consume cards.
const PocketSources = (() => {
  const nax = 'https://nax.moe/';
  const arca = 'https://arca.live/b/aiart/185686780';
  const tagGalleries = [
    {
      id: 'gelbooru',
      label: 'Gelbooru',
      search: 'https://gelbooru.com/index.php?page=post&s=list',
      defaultTag: 'all',
    },
    {
      id: 'danbooru',
      label: 'Danbooru',
      search: 'https://danbooru.donmai.us/posts',
    },
  ];
  const galleries = [
    ['danbooru-artist-tags-2-v5', 'artist', 'V5', '宽松提示词'],
    ['danbooru-artist-tags-v5', 'artist', 'V5', '约束提示词'],
    ['danbooru-artist-tags-male-2-v5', 'artist', 'V5', '男性角色样图'],
    ['danbooru-artist-tags-2-v4.5', 'artist', 'V4.5', '宽松提示词'],
    ['danbooru-artist-tags-v4.5', 'artist', 'V4.5', '约束提示词'],
    ['artists-v4.5', 'artist', 'V4.5', '精选样图'],
    ['danbooru-character-tags-v5', 'character', 'V5', '角色样图'],
    ['danbooru-character-tags-v4.5', 'character', 'V4.5', '角色样图'],
    ['danbooru-hair-tags-v5', 'knowledge', 'V5', '发型样图', 'hair'],
    ['danbooru-hair-tags-v4.5', 'knowledge', 'V4.5', '发型样图', 'hair'],
    ['danbooru-face-tags-v4.5', 'knowledge', 'V4.5', '表情样图', 'expression'],
  ];

  const knowledgeKinds = [
    ['pose', '动作姿势'], ['composition', '镜头构图'], ['lighting', '光线氛围'],
    ['expression', '表情'], ['hair', '发型'], ['clothing', '服装'], ['general', '通用写法'],
  ];
  // These Chinese labels are this project's translations; the original tag is copied unchanged.
  const knowledgeNames = {
    'hime cut': '姬发式', 'ponytail': '马尾', 'high ponytail': '高马尾',
    'side ponytail': '侧马尾', 'short ponytail': '短马尾', 'twintails': '双马尾',
    'low twintails': '低双马尾', 'short twintails': '短双马尾', 'twin braids': '双辫',
    'braid': '辫子', 'single braid': '单辫', 'side braid': '侧辫', 'crown braid': '冠状编发',
    'hair bun': '发髻', 'double bun': '双丸子头', 'topknot': '高发髻',
    'long hair': '长发', 'very long hair': '很长的头发', 'short hair': '短发',
    'very short hair': '很短的头发', 'medium hair': '中长发', 'bob cut': '波波头',
    'pixie cut': '精灵短发', 'wolf cut': '狼尾发型', 'mullet': '鲻鱼头',
    'straight hair': '直发', 'wavy hair': '波浪发', 'curly hair': '卷发',
    'messy hair': '凌乱头发', 'spiked hair': '尖刺发型', 'ahoge': '呆毛',
    'bangs': '刘海', 'blunt bangs': '齐刘海', 'parted bangs': '分开的刘海',
    'swept bangs': '斜刘海', 'hair over one eye': '遮住一只眼睛的头发',
    'hair over eyes': '遮住双眼的头发', 'hair slicked back': '向后梳的头发',
    'hair down': '披发', 'hair up': '盘起头发', 'half updo': '半扎发',
    'smile': '微笑', 'grin': '露齿笑', 'smirk': '坏笑', 'frown': '皱眉',
    'angry': '生气', 'annoyed': '不悦', 'surprised': '惊讶', 'shocked': '震惊',
    'confused': '困惑', 'embarrassed': '害羞', 'blush': '脸红', 'crying': '哭泣',
    'tears': '眼泪', 'sad': '难过', 'expressionless': '无表情', 'neutral face': '平静表情',
    'closed eyes': '闭眼', 'half-closed eyes': '半闭眼', 'one eye closed': '眨一只眼',
    'open mouth': '张嘴', 'closed mouth': '闭嘴', 'pout': '嘟嘴', 'sleepy': '困倦',
  };

  function onlineCards(index, revision = '') {
    const cards = new Map();
    const version = revision ? `?rev=${encodeURIComponent(revision)}` : '';
    for (const [gallery, section, model, label, kind] of galleries) {
      for (const [title, file] of index[gallery] ?? []) {
        const id = `nax:${section}:${model}:${title}`;
        if (!cards.has(id)) {
          cards.set(id, {
            id, section, model, kind,
            title: section === 'knowledge' && knowledgeNames[title] ? `${knowledgeNames[title]} · ${title}` : title,
            source: 'NAX', license: 'CC BY 4.0',
            sourceUrl: `${nax}?gallery=${gallery}`,
            prompt: section === 'artist' ? `artist:${title}` : title,
            note: section === 'knowledge' ? 'NAX 使用固定参数对照单个标签的效果。样图供参考，换模型、种子或提示词后效果可能不同。部分中文名称由本项目整理，复制时保留原英文标签。' : undefined,
            photos: [],
          });
        }
        cards.get(id).photos.push({
          url: `/nax-image/${gallery}/${encodeURIComponent(file)}${version}`,
          label,
        });
      }
    }
    return [...cards.values()].sort((a, b) => a.title.localeCompare(b.title, 'en'));
  }

  function koreanCards(index) {
    const pack = index.source.id || 'curated';
    const packName = pack === 'curated' ? 'Curated 精选' : `${pack}-Q`;
    const imageRoot = pack === 'curated' ? '/korean-image' : `/korean-image/${pack}`;
    return index.artists.map(([title, images, postCount]) => ({
      id: `korean:V5:${title}`, title, model: 'V5', section: 'artist',
      source: `韩国原版 · ${packName}`, sourceUrl: index.source.post,
      prompt: `artist:${title}`, note: `样图来自 bequiet 的 ${packName}，打开时按需读取。`,
      photos: images.map(([offset, size], number) => ({ url: `${imageRoot}/${offset}/${size}`, label: `${packName} · ${number + 1}` })),
      ...(Number.isSafeInteger(postCount) && postCount >= 0 ? { postCount } : {}),
    })).sort((a, b) => a.title.localeCompare(b.title, 'en'));
  }

  function packCards(pack, index) {
    const model = pack.name.includes('4.5') ? 'V4.5' : /nai[d]?5/i.test(pack.name) ? 'V5' : '未标注';
    return index.map(([title, images], i) => ({
      id: `pack:${pack.id}:${i}`, title, model, section: 'artist',
      source: pack.name,
      sourceUrl: /^NAID5/i.test(pack.name) ? arca : undefined,
      prompt: `artist:${title}`,
      photos: images.map(([offset, size], number) => ({
        url: `/pack-image/${pack.id}/${offset}/${size}`,
        label: `预览 ${number + 1}`,
      })),
    }));
  }

  const tagDocs = 'https://docs.novelai.net/en/image/tags/';
  const example = (title, prompt, note, kind = 'pose', model = '通用', sourceUrl = tagDocs) => ({
    id: `guide:${title}`, title, prompt, note, kind, section: 'knowledge',
    model, source: '本地入门知识', sourceUrl, photos: [],
  });
  const reference = (title, note, sourceUrl, kind, source) => ({
    id: `guide:${title}`, title, note, kind, section: 'knowledge',
    model: '参考资料', source, sourceUrl, photos: [],
  });
  const knowledge = [
    example('站立', 'standing', '指定基本姿势。先选一个主要姿势，再补身体朝向；同一角色不要同时写站立和坐着。'),
    example('坐着', 'sitting', '先指定坐姿，再补坐在哪里。需要明确接触关系时，可以另写英文句子描述人物与椅子的关系。'),
    example('跪姿', 'kneeling', '描述膝部着地的姿势。可再补上身体朝向或镜头视角。'),
    example('跑动', 'running', '描述奔跑动作。可以另写奔跑方向和场景，避免同时叠加静止姿势。'),
    example('回头看', 'looking back', '描述人物回头。身体朝向与视线方向可以另外说明。'),
    example('手叉腰', 'hand on hip', '描述单手放在髋侧。需要指定哪只手时，再用英文句子补充。'),
    example('牵手', 'holding hands', '适合有多名角色的互动。先写人数，再说明谁牵着谁；该词本身不指定左右手。'),
    example('行走', 'walking', '描述走路动作。可与场景词组合，例如 walking, outdoors。'),
    example('双臂抱胸', 'crossed arms', '描述双臂交叉放在胸前，可另补站立或坐姿。'),
    example('从低处仰拍', 'from below', '镜头从下方看向主体。与 from above 是不同机位，同一个镜头通常只选一个。', 'composition'),
    example('从高处俯拍', 'from above', '镜头从上方看向主体。需要交代距离时，再选一个取景词。', 'composition'),
    example('肖像近景', 'portrait', '将取景集中在头肩区域。不要同时要求 full body，以免产生相互冲突的取景要求。', 'composition'),
    example('上半身', 'upper body', '以人物上半身为主。适合展示表情、手势和上衣。', 'composition'),
    example('全身构图', 'full body', '希望头部到脚部都在画面中。若脚仍被裁切，可以先减少冲突的近景描述。', 'composition'),
    example('侧面视角', 'from side', '将机位放到主体侧面。可搭配 from above 或 from below 表示俯仰角。', 'composition'),
    example('背景虚化', 'blurry background', '用于突出主体、减弱背景细节。先明确主体，再决定背景虚化程度。', 'composition'),
    example('逆光', 'backlighting', '让主要光源来自主体背后。可以另外交代太阳、窗户或灯的位置。', 'lighting'),
    example('轮廓光', 'rim lighting', '强调主体边缘的光线。可用于让头发、肩部与背景区分开。', 'lighting'),
    example('阳光', 'sunlight', '描述阳光照明；也可以补上白天、窗边或户外环境。', 'lighting'),
    example('微笑', 'smile', '从简单的情绪词开始。还想控制嘴部时，可另选 open mouth 或 closed mouth。', 'expression'),
    example('惊讶', 'surprised', '描述惊讶情绪。表情图库可查看固定参数下的效果，但换提示词后可能不同。', 'expression'),
    example('闭眼', 'closed eyes', '控制眼睛闭合。与 looking at viewer 这类看向目标的要求同时出现时，可能难以表达清楚。', 'expression'),
    example('马尾', 'ponytail', '描述马尾发型。可以补 high ponytail 或 side ponytail，选择与目标相符的一种。', 'hair'),
    example('双马尾', 'twintails', '描述两束马尾。注意与编成辫子的 twin braids 区分。', 'hair'),
    example('短发', 'short hair', '描述头发长度；发型与刘海可分别指定，避免同时写 long hair。', 'hair'),
    example('连帽衫', 'hoodie', '指定基础服装类型。颜色和是否戴帽可另写，先保证主要服装一致。', 'clothing'),
    example('连衣裙', 'dress', '指定连衣裙。可逐步补颜色、袖长和材质，不必一次堆入很多相近服装名。', 'clothing'),
    example('外套', 'coat', '用于外套或大衣。需要多层穿搭时，用句子说明内搭与外套的关系。', 'clothing'),
    example('户外', 'outdoors', '先确定人物处在户外，再添加具体地点。与 indoors 通常不要同时用于同一个场景。', 'general'),
    example('简单背景', 'simple background', '让背景更简洁。想展示具体场景时，优先写场景本身，检查是否存在冲突。', 'general'),
    example('V5 画面复杂度', 'high complexity', '这是 V5 的复杂度选项，不是必加的质量尾。可对照尝试 low、medium、high 或 ultra complexity，并选择一个。', 'general', 'V5'),
    example('V5 透明背景', 'transparent background', 'V5 支持真实透明背景。该词用于背景透明；若需要物体半透明效果，可查看官方 has alpha / alpha transparency 说明。', 'general', 'V5'),
    example('单个词稍微加强', '1.2::smile::', '数值权重只包住需要调整的词，并用结尾的双冒号闭合。先试默认提示词，再按实际效果小幅调整。', 'general', 'V5 / V4.5', 'https://docs.novelai.net/en/image/strengthening-weakening/'),
  ];
  const references = [
    reference('NovelAI 标签指南', '官方标签用法、V5 复杂度与透明背景等说明。内置中文短语是本项目整理的入门示例，不是官方文章译文。', tagDocs, 'general', 'NovelAI'),
    reference('NovelAI 强调与弱化', '查看数值权重的语法和适用版本。', 'https://docs.novelai.net/en/image/strengthening-weakening/', 'general', 'NovelAI'),
    reference('韩国社区 · 姿势图文', 'DC Inside 的姿势标签帖子。打开原帖查看英文标签和样图。', 'https://gall.dcinside.com/mini/board/view/?id=wrtnw&no=139401', 'pose', 'DC Inside'),
    reference('韩国社区 · 手势图文', 'DC Inside 的手势标签帖子。', 'https://gall.dcinside.com/mini/board/view/?id=wrtnw&no=138201', 'pose', 'DC Inside'),
    reference('韩国社区 · NAI 标签汇总', '含 V4.5 Full 画师串、眼型、照明、色彩与动作索引。', 'https://gall.dcinside.com/mini/board/view/?id=wrtnw&no=152281', 'general', 'DC Inside'),
  ];

  function tagGalleryTag(value) {
    return String(value ?? '').normalize('NFKC').trim()
      .replace(/^(?:artist|character)\s*:\s*/i, '')
      .replace(/\\([\\_(),])/g, '$1')
      .replace(/\s+/g, '_');
  }

  function tagGallerySearchUrl(id, value) {
    const gallery = tagGalleries.find((item) => item.id === id);
    if (!gallery) return '';
    const tag = tagGalleryTag(value) || gallery.defaultTag;
    const url = new URL(gallery.search);
    if (tag) url.searchParams.set('tags', tag);
    return url.href;
  }

  function tagGalleryWebsiteUrl(id, query, rating = 'general', sort = 'newest') {
    const gallery = tagGalleries.find((item) => item.id === id);
    if (!gallery) return '';
    const terms = String(query ?? '').trim().split(/\s+/)
      .filter((term) => term && !/^[-~]?(?:rating|order|sort):/i.test(term));
    if (['general', 'sensitive', 'questionable', 'explicit'].includes(rating)) terms.push(`rating:${rating}`);
    if (sort === 'popular') terms.push(id === 'danbooru' ? 'order:score' : 'sort:score:desc');
    const url = new URL(gallery.search);
    const tags = terms.join(' ') || gallery.defaultTag;
    if (tags) url.searchParams.set('tags', tags);
    return url.href;
  }

  return {
    onlineCards, koreanCards, packCards, knowledge, references, knowledgeKinds,
    tagGalleries, tagGalleryTag, tagGallerySearchUrl, tagGalleryWebsiteUrl, nax, arca,
  };
})();
