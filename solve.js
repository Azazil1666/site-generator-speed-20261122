// makefun-site 1.0.0 high-performance implementation in Node.js 22
import { Buffer } from 'node:buffer';

export function run(input) {
  const site = input.site || {};
  const siteTitle = site.title || '';
  const rawBaseUrl = site.base_url || '';
  // base_url with trailing slashes dropped
  const base = rawBaseUrl.replace(/\/+$/, '');
  const perPage = site.per_page || 10;
  const recentCount = site.recent || 5;

  const templatesRaw = input.templates || {};
  const filesRaw = input.files || [];

  const reportLines = [];
  const addReport = (line) => reportLines.push(line);

  // 1. Sources & Static files
  // Sort files by path in code-unit order
  const sortedFiles = [...filesRaw].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const sources = [];
  const statics = [];

  for (const f of sortedFiles) {
    if (f.path.endsWith('.md')) {
      const normalizedContent = (f.content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      sources.push({ path: f.path, content: normalizedContent });
    } else {
      statics.push({ path: f.path, content: f.content || '' });
    }
  }

  // 2. Templates
  const templateNames = Object.keys(templatesRaw).sort();
  const parsedTemplates = new Map(); // name -> template AST / render function

  // Helper for template parsing errors
  const reportTemplateError = (name, reason) => {
    addReport(`template "${name}": ${reason}`);
  };

  for (const name of templateNames) {
    const src = templatesRaw[name];
    try {
      const compiled = parseTemplate(name, src, reportTemplateError);
      if (compiled) {
        parsedTemplates.set(name, compiled);
      }
    } catch (err) {
      reportTemplateError(name, err.message || 'invalid template');
    }
  }

  // 3. Front matter & source validation
  const validSources = [];

  for (const src of sources) {
    const parseResult = parseFrontMatter(src.path, src.content);
    if (parseResult.error) {
      addReport(`${parseResult.error}`);
      continue;
    }
    const fm = parseResult.frontMatter;
    const body = parseResult.body;

    // Checks order:
    // 1. no title
    if (!fm.title) {
      addReport(`refused ${src.path}: no title`);
      continue;
    }
    // 2. tags/ or page/
    if (src.path.startsWith('tags/') || src.path.startsWith('page/')) {
      const dir = src.path.startsWith('tags/') ? 'tags/' : 'page/';
      addReport(`refused ${src.path}: ${dir} is the generator's own`);
      continue;
    }
    // 3. post (under posts/) with no date
    const isPost = src.path.startsWith('posts/');
    if (isPost && !fm.date) {
      addReport(`refused ${src.path}: a post needs a date`);
      continue;
    }
    // 4. layout is no template that parses
    const layoutName = fm.layout || (isPost ? 'post' : 'page');
    if (!parsedTemplates.has(layoutName)) {
      addReport(`refused ${src.path}: layout "${layoutName}" is no template that parses`);
      continue;
    }
    // 5. draft: true
    if (fm.draft === true) {
      addReport(`draft ${src.path}`);
      continue;
    }

    validSources.push({
      path: src.path,
      directory: getDirectory(src.path),
      isPost,
      fm,
      body,
      layoutName
    });
  }

  // 4. Permalinks
  // Directory & slug uniqueness
  const takenPaths = new Set(['posts', 'tags', 'page']);
  // Pre-fill taken paths from existing directories or files if needed, but spec says:
  // "At the root, posts, tags and page are taken from the start."

  const pages = [];
  const posts = [];

  // Sort validSources by source order (which they already are in sortedFiles)
  for (const src of validSources) {
    const isPost = src.isPost;
    const directory = src.directory;
    const baseSlug = src.fm.slug || slugify(src.fm.title);
    
    // Make unique in its directory in source order: s, s-2, s-3, ...
    let slug = baseSlug;
    let counter = 2;
    // Key in directory: directory ? `${directory}/${slug}` : slug
    // Wait, how are permalinks scoped?
    // "slug of its title, made unique in its directory in source order: the first of s, s-2, s-3 and so on not yet taken. At the root, posts, tags and page are taken from the start."
    // What is a directory's namespace? For docs/a/x.md, directory is docs/a. Its slug namespace is within docs/a.
    // Let's track taken slugs per directory.
    if (!src.dirSlugs) src.dirSlugs = new Map(); // directory -> Set of slugs
  }

  // Let's implement robust permalink assignment:
  const dirSlugs = new Map(); // dir -> Set of slugs
  // Root taken:
  dirSlugs.set('', new Set(['posts', 'tags', 'page']));

  const brokenLinks = new Set(); // store broken links globally or per source

  for (const src of validSources) {
    // A post's directory is always `posts/`; a page's is its source's directory.
    const dir = src.isPost ? 'posts' : src.directory;
    if (!dirSlugs.has(dir)) {
      dirSlugs.set(dir, new Set());
    }
    const set = dirSlugs.get(dir);
    const baseSlug = src.fm.slug || slugify(src.fm.title);
    let slug = baseSlug;
    let n = 2;
    while (set.has(slug)) {
      slug = `${baseSlug}-${n}`;
      n++;
    }
    set.add(slug);

    src.slug = slug;
    src.url = base === '' ? `/${dir ? dir + '/' : ''}${slug}/` : `${base}/${dir ? dir + '/' : ''}${slug}/`;
    // Output path: <directory>/<slug>/index.html (if directory is empty, <slug>/index.html)
    src.outputPath = `${dir ? dir + '/' : ''}${slug}/index.html`;

    if (src.isPost) {
      posts.push(src);
    }
    pages.push(src);
  }

  // 5. Markdown rendering & link resolution
  // We need all page URLs for link resolution.
  const urlToPage = new Map();
  for (const p of pages) {
    urlToPage.set(p.url, p);
  }
  // Also static files paths
  const staticPaths = new Set(statics.map(s => s.path));

  for (const p of pages) {
    const renderResult = renderMarkdown(p.body, p.path, base, urlToPage, staticPaths, brokenLinks);
    p.contentHtml = renderResult.html;
    p.excerptHtml = renderResult.excerpt;
    p.toc = renderResult.toc;
  }

  // Sort broken links and add to report
  const sortedBrokenLinks = [...brokenLinks].sort();
  for (const bl of sortedBrokenLinks) {
    addReport(bl);
  }

  // 6. Collections
  // Posts: newest date first, equal dates by slug in code-unit order.
  posts.sort((a, b) => {
    const da = a.fm.date || '';
    const db = b.fm.date || '';
    if (da !== db) {
      return db < da ? -1 : 1; // descending date
    }
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    post.newer = i > 0 ? createCard(posts[i - 1]) : null;
    post.older = i < posts.length - 1 ? createCard(posts[i + 1]) : null;
  }

  // Recent posts
  const recentPosts = posts.slice(0, recentCount).map(p => createCard(p));

  // 7. Tags
  // Each post's tags, each slug once (first spelling kept), in its own order.
  // Tag is all posts whose tags have its slug, named as first met walking posts in collection order.
  // URL: <base>/tags/<slug>/
  const tagMap = new Map(); // slug -> { name, slug, url, posts: [], count: 0, firstMetName }
  const tagOrder = []; // slugs in order of first appearance

  for (const post of posts) {
    const rawTags = post.fm.tags || [];
    // Each post's tags, each slug once (first spelling kept): dedupe by slug
    // before counting, so a post with two spellings of one tag counts once.
    const seenSlugs = new Set();
    for (const rawTagName of rawTags) {
      const tagSlug = slugify(rawTagName);
      if (seenSlugs.has(tagSlug)) continue;
      seenSlugs.add(tagSlug);
      if (!tagMap.has(tagSlug)) {
        const tagObj = {
          name: rawTagName,
          slug: tagSlug,
          url: base === '' ? `/tags/${tagSlug}/` : `${base}/tags/${tagSlug}/`,
          posts: [],
          count: 0
        };
        tagMap.set(tagSlug, tagObj);
        tagOrder.push(tagObj);
      }
      const tagObj = tagMap.get(tagSlug);
      tagObj.posts.push(post);
      tagObj.count++;
    }
  }

  // Convert each tag's posts to cards now that the map is complete, so every
  // card's tags resolve their canonical names and urls.
  for (const tagObj of tagMap.values()) {
    tagObj.posts = tagObj.posts.map(p => createCard(p, tagMap));
  }

  // Tags ordered by post count (most first), then by slug (code-unit order).
  const tagsList = [...tagMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // For pages/posts tags attribute: each tag { name, slug, url } where url is tag.url or "" if no post has that tag.
  // Wait, spec: "A page's tags link to the tag of the same slug, or have the url "" where no post has that tag."
  // Wait, if a post has tags, their url is tag.url if tagMap has it, else "".

  // 8. Layouts & Output Generation
  const outputTree = {};

  let builtPagesCount = 0;
  let builtPostsCount = 0;
  let builtTagsCount = 0;
  let builtStaticCount = 0;

  // Render pages & posts
  for (const p of pages) {
    const pageCard = createPageCard(p, tagMap, base);
    const scope = {
      site: { title: siteTitle, base_url: base, per_page: perPage, recent: recentCount },
      tags: tagsList,
      recent: recentPosts,
      page: pageCard,
      slug: p.slug,
      content: p.contentHtml,
      toc: p.toc,
      newer: p.newer,
      older: p.older,
      is_post: p.isPost
    };

    const templateFn = parsedTemplates.get(p.layoutName);
    if (templateFn) {
      const rendered = renderTemplate(templateFn, scope, parsedTemplates, reportTemplateError);
      outputTree[p.outputPath] = rendered;
      if (p.isPost) builtPostsCount++;
      else builtPagesCount++;
    }
  }

  // Index (pagination)
  // site.per_page posts a page: index.html, then page/2/index.html and on (at least one, even with no posts)
  const perPageCount = perPage > 0 ? perPage : 10;
  const totalPages = Math.max(1, Math.ceil(posts.length / perPageCount));

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const start = (pageNum - 1) * perPageCount;
    const pagePosts = posts.slice(start, start + perPageCount).map(p => createCard(p, tagMap));

    const pageUrl = pageNum === 1 
      ? (base === '' ? '/' : `${base}/`) 
      : (base === '' ? `/page/${pageNum}/` : `${base}/page/${pageNum}/`);
    
    const newerUrl = pageNum === 1 ? '' : (pageNum === 2 ? (base === '' ? '/' : `${base}/`) : (base === '' ? `/page/${pageNum - 1}/` : `${base}/page/${pageNum - 1}/`));
    const olderUrl = pageNum >= totalPages ? '' : (base === '' ? `/page/${pageNum + 1}/` : `${base}/page/${pageNum + 1}/`);

    const pager = {
      number: pageNum,
      total: totalPages,
      url: pageUrl,
      newer_url: newerUrl,
      older_url: olderUrl
    };

    const indexScope = {
      site: { title: siteTitle, base_url: base, per_page: perPage, recent: recentCount },
      tags: tagsList,
      recent: recentPosts,
      posts: pagePosts,
      pager
    };

    const templateFn = parsedTemplates.get('index');
    if (templateFn) {
      const rendered = renderTemplate(templateFn, indexScope, parsedTemplates, reportTemplateError);
      const outPath = pageNum === 1 ? 'index.html' : `page/${pageNum}/index.html`;
      outputTree[outPath] = rendered;
      // Index pagination pages are not counted in "built <n> pages" — only
      // source pages (non-posts) count there.
    }
  }

  // Tag pages: each tag through `tag` at `tags/<slug>/index.html`, with `tag`; and `tags/index.html` through `tags`.
  for (const tag of tagsList) {
    const tagScope = {
      site: { title: siteTitle, base_url: base, per_page: perPage, recent: recentCount },
      tags: tagsList,
      recent: recentPosts,
      tag: {
        name: tag.name,
        slug: tag.slug,
        url: tag.url,
        count: tag.count,
        posts: tag.posts
      }
    };
    const templateFn = parsedTemplates.get('tag');
    if (templateFn) {
      const rendered = renderTemplate(templateFn, tagScope, parsedTemplates, reportTemplateError);
      outputTree[`tags/${tag.slug}/index.html`] = rendered;
      builtTagsCount++;
    }
  }

  // tags/index.html through `tags` — built but not counted in "built <n> tags".
  const tagsScope = {
    site: { title: siteTitle, base_url: base, per_page: perPage, recent: recentCount },
    tags: tagsList,
    recent: recentPosts
  };
  const tagsTemplateFn = parsedTemplates.get('tags');
  if (tagsTemplateFn) {
    const rendered = renderTemplate(tagsTemplateFn, tagsScope, parsedTemplates, reportTemplateError);
    outputTree['tags/index.html'] = rendered;
  }

  // Static files
  for (const stat of statics) {
    if (outputTree[stat.path]) {
      addReport(`shadowed ${stat.path}: a built page has its path`);
    } else {
      outputTree[stat.path] = stat.content;
      builtStaticCount++;
    }
  }

  // 9. Report (`build-report.txt`)
  // every line reported above and each broken link ..., sorted in code-unit order, then built ...
  reportLines.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const summaryLine = `built ${builtPagesCount} pages, ${builtPostsCount} posts, ${builtTagsCount} tags and ${builtStaticCount} static files`;
  reportLines.push(summaryLine);

  outputTree['build-report.txt'] = reportLines.join('\n') + '\n';

  return outputTree;
}

// --- Helpers & Parsers ---

function slugify(text) {
  if (!text) return 'untitled';
  // Unicode NFKD, drop combining marks \p{M}
  const nfkd = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const lower = nfkd.toLowerCase();
  const slugged = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  if (!slugged) return 'untitled';
  if (slugged.length <= 64) return slugged;
  const cut = slugged.slice(0, 64);
  return cut.replace(/-+$/, '') || 'untitled';
}

function formatDateLong(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const months = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (month < 1 || month > 12) return dateStr;
  return `${day} ${months[month]} ${year}`;
}

function getDirectory(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_ESCAPE_RE = /[&<>"']/g;
function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  // Fast path for a single character (the common case in renderInline):
  // a plain object lookup, no regex.
  if (str.length === 1) {
    const e = HTML_ESCAPES[str];
    return e !== undefined ? e : str;
  }
  // Single pass over the string (one regex, callback only on a match),
  // instead of five separate .replace() scans.
  return str.replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPES[c]);
}

function parseFrontMatter(path, content) {
  const lines = content.split('\n');
  if (lines.length === 0 || lines[0] !== '---') {
    return { error: `refused ${path}: no front matter` };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { error: `refused ${path}: the front matter is not closed` };
  }

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join('\n');
  const fm = {};
  const seenKeys = new Set();

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const lineNum = i + 2; // 1-based, counted from 1 at the opening ---

    // blank line (spaces and tabs only)
    if (/^[ \t]*$/.test(line)) {
      continue;
    }
    // comment opening on #
    if (/^[ \t]*#/.test(line)) {
      continue;
    }

    // key: value
    // key of a-z and _, colon, one space, value (trailing spaces/tabs dropped).
    // A bare `key:` (colon, end of line) is a key with no value.
    const match = line.match(/^([a-z_]+):(?: (.*))?$/);
    if (!match) {
      return { error: `refused ${path}: line ${lineNum} is not "key: value"` };
    }

    const key = match[1];
    let rawVal = (match[2] || '').replace(/[ \t]+$/, '');

    if (seenKeys.has(key)) {
      return { error: `refused ${path}: key "${key}" is given twice` };
    }
    seenKeys.add(key);

    const validKeys = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);
    if (!validKeys.has(key)) {
      return { error: `refused ${path}: unknown key "${key}"` };
    }

    if (rawVal === '') {
      return { error: `refused ${path}: key "${key}" has no value` };
    }

    // Parse value according to key type
    if (key === 'title' || key === 'summary') {
      if (rawVal.startsWith('"')) {
        // Quoted string: "...", escapes \" and \\, no other quote inside
        if (!rawVal.endsWith('"') || rawVal.length < 2) {
          return { error: `refused ${path}: key "${key}": a quoted string is not closed` };
        }
        // Validate quotes and escapes
        let str = '';
        let escaped = false;
        let valid = true;
        for (let j = 1; j < rawVal.length - 1; j++) {
          const ch = rawVal[j];
          if (escaped) {
            if (ch === '"' || ch === '\\') {
              str += ch;
            } else {
              valid = false;
              break;
            }
            escaped = false;
          } else {
            if (ch === '\\') {
              escaped = true;
            } else if (ch === '"') {
              valid = false; // unescaped quote inside
              break;
            } else {
              str += ch;
            }
          }
        }
        if (!valid || escaped) {
          return { error: `refused ${path}: key "${key}": a quoted string is not closed` };
        }
        fm[key] = str;
      } else {
        // Bare string: never opening on " or [
        if (rawVal.startsWith('[')) {
          return { error: `refused ${path}: key "${key}": a bare string opens on [` };
        }
        fm[key] = rawVal;
      }
    } else if (key === 'date') {
      // YYYY-MM-DD, real day from 1970-01-01 to 2099-12-31
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rawVal)) {
        return { error: `refused ${path}: key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)` };
      }
      const [y, m, d] = rawVal.split('-').map(Number);
      const dateObj = new Date(Date.UTC(y, m - 1, d));
      if (
        dateObj.getUTCFullYear() !== y ||
        dateObj.getUTCMonth() !== m - 1 ||
        dateObj.getUTCDate() !== d ||
        y < 1970 || y > 2099
      ) {
        return { error: `refused ${path}: key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)` };
      }
      fm[key] = rawVal;
    } else if (key === 'tags') {
      // [a, b, c], each name trimmed, none empty or holding ", [, ]; [] is no tags
      if (!rawVal.startsWith('[') || !rawVal.endsWith(']')) {
        return { error: `refused ${path}: key "tags": not a list [a, b]` };
      }
      const inner = rawVal.slice(1, -1).trim();
      if (inner === '') {
        fm[key] = [];
      } else {
        const parts = inner.split(',');
        const tagsArr = [];
        for (const p of parts) {
          const trimmed = p.trim();
          if (trimmed === '' || trimmed.includes('"') || trimmed.includes('[') || trimmed.includes(']')) {
            return { error: `refused ${path}: key "tags": an empty tag, or one holding " [ or ]` };
          }
          tagsArr.push(trimmed);
        }
        fm[key] = tagsArr;
      }
    } else if (key === 'draft') {
      if (rawVal === 'true') fm[key] = true;
      else if (rawVal === 'false') fm[key] = false;
      else {
        return { error: `refused ${path}: key "draft": true or false` };
      }
    } else if (key === 'layout') {
      // template name: a-z, 0-9 and -
      if (!/^[a-z0-9-]+$/.test(rawVal)) {
        return { error: `refused ${path}: key "layout" has no value` };
      }
      fm[key] = rawVal;
    } else if (key === 'slug') {
      // slug: a-z, 0-9, single - between, at most 64 chars
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(rawVal) || rawVal.length > 64) {
        return { error: `refused ${path}: key "slug": not a slug` };
      }
      fm[key] = rawVal;
    }
  }

  return { frontMatter: fm, body };
}

function createCard(post, tagMap) {
  // Word count without splitting the body into an array (allocation-free
  // scan: count non-whitespace runs).
  let wordCount = 0;
  let inWord = false;
  const body = post.body;
  for (let k = 0; k < body.length; k++) {
    const c = body.charCodeAt(k);
    const isWs = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
    if (isWs) inWord = false;
    else if (!inWord) { inWord = true; wordCount++; }
  }
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 200));

  // Excerpt: HTML of its body's first paragraph (the first top-level <p>
  // block, recorded at render time — a <p> inside a blockquote does not
  // count). Falls back to the regex scan when the render-time value is
  // absent.
  const firstParaHtml = post.excerptHtml !== undefined ? post.excerptHtml : getFirstParagraphHtml(post.contentHtml);

  return {
    title: post.fm.title,
    url: post.url,
    date: post.fm.date || '',
    date_long: formatDateLong(post.fm.date || ''),
    summary: post.fm.summary || '',
    excerpt: firstParaHtml,
    reading_minutes: readingMinutes,
    tags: (() => {
      // Each post's tags, each slug once (first spelling kept): dedupe by slug.
      const out = [];
      const seenSlugs = new Set();
      for (const t of (post.fm.tags || [])) {
        const slug = slugify(t);
        if (seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        // The tag's name is the canonical name (first spelling met walking the
        // posts in collection order) and its url the tag's url; where the tag
        // is not in the map (card built before the map exists), fall back to
        // this post's own spelling and an empty url.
        const tagObj = tagMap ? tagMap.get(slug) : null;
        out.push({
          name: tagObj ? tagObj.name : t,
          slug: slug,
          url: tagObj ? tagObj.url : ''
        });
      }
      return out;
    })()
  };
}

function getFirstParagraphHtml(html) {
  // The excerpt is the INNER html of the first paragraph, without the
  // surrounding <p>...</p> wrapper.
  const match = html.match(/<p>([\s\S]*?)<\/p>/);
  return match ? match[1] : '';
}

function createPageCard(p, tagMap, base) {
  const bodyWords = p.body.trim() ? p.body.trim().split(/\s+/) : [];
  const wordCount = bodyWords.length;
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 200));
  const firstParaHtml = getFirstParagraphHtml(p.contentHtml);

  // Each post's tags, each slug once (first spelling kept): dedupe by slug
  // before building the page's tag list, so a post with two spellings of
  // one tag lists it once.
  const tagsArr = [];
  {
    const seenSlugs = new Set();
    for (const t of (p.fm.tags || [])) {
      const slug = slugify(t);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      const tagObj = tagMap.get(slug);
      // The tag's name is the canonical name (first spelling met walking the
      // posts in collection order), not this page's own spelling.
      tagsArr.push({
        name: tagObj ? tagObj.name : t,
        slug: slug,
        url: tagObj ? tagObj.url : ''
      });
    }
  }

  return {
    title: p.fm.title,
    url: p.url,
    date: p.fm.date || '',
    date_long: formatDateLong(p.fm.date || ''),
    summary: p.fm.summary || '',
    excerpt: firstParaHtml,
    reading_minutes: readingMinutes,
    tags: tagsArr,
    slug: p.slug,
    content: p.contentHtml,
    toc: p.toc,
    newer: p.newer ?? null,
    older: p.older ?? null,
    is_post: p.isPost
  };
}

// --- Markdown Renderer ---

function renderMarkdown(body, sourcePath, base, urlToPage, staticPaths, brokenLinks) {
  const lines = body.split('\n');
  const blocks = [];
  const toc = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (/^[ \t]*$/.test(line)) {
      i++;
      continue;
    }

    // Fence: ^```(\w[-+_]*)?[ \t]*$
    const fenceMatch = line.match(/^```([a-zA-Z0-9_\+\-]*)?[ \t]*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      i++;
      const codeLines = [];
      while (i < lines.length) {
        if (/^```[ \t]*$/.test(lines[i])) {
          i++;
          break;
        }
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      const classAttr = lang ? ` class="language-${lang}"` : '';
      blocks.push(`<pre><code${classAttr}>${codeLines.join('\n')}\n</code></pre>`);
      continue;
    }

    // Thematic break: --- or ***, spaces or tabs only
    if (/^([ \t]*---[ \t]*|[ \t]*\*\*\*[ \t]*)$/.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }

    // Heading: 1 to 6 #, at least one space or tab, text
    const headingMatch = line.match(/^(#{1,6})[ \t]+(.*)$/);
    if (headingMatch) {
      const hashes = headingMatch[1];
      const level = hashes.length;
      let rawText = headingMatch[2];
      // spaces and tabs at its end dropped; closing #s kept as text (or stripped? Spec says: "closing #s are kept as text" wait: "spaces and tabs at its end dropped; closing #s are kept as text")
      rawText = rawText.replace(/[ \t]+$/, '');
      const slugId = slugify(rawText);
      // Make unique in page
      let id = slugId;
      // We will handle unique ids in toc / headings
      toc.push({ level, id, rawText, sourceLine: line });
      const inlineHtml = renderInline(rawText, sourcePath, base, urlToPage, staticPaths, brokenLinks);
      blocks.push(`<h${level} id="${id}">${inlineHtml}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote: a run of lines starting with >, each with > and one space
    // after dropped, trimmed, empty ones dropped. Only at a block boundary —
    // a > line inside a paragraph stays paragraph text (the paragraph loop
    // does not break on it).
    if (line.startsWith('>')) {
      const bqLines = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        let bqLine = lines[i].slice(1);
        if (bqLine.startsWith(' ')) {
          bqLine = bqLine.slice(1);
        }
        bqLine = bqLine.trim();
        if (bqLine !== '') {
          bqLines.push(bqLine);
        }
        i++;
      }
      if (bqLines.length === 0) {
        blocks.push('<blockquote>\n</blockquote>');
      } else {
        const inner = renderInline(bqLines.join('\n'), sourcePath, base, urlToPage, staticPaths, brokenLinks);
        blocks.push(`<blockquote>\n<p>${inner}</p>\n</blockquote>`);
      }
      continue;
    }

    // List: - , * , or digits and .
    const ulMatch = line.match(/^([ \t]*)([\-\*])[ \t]+(.*)$/);
    const olMatch = line.match(/^([ \t]*)(\d+)\.[ \t]+(.*)$/);

    if (ulMatch || olMatch) {
      const isOrdered = !!olMatch;
      const firstNum = isOrdered ? parseInt(olMatch[2], 10) : 0;
      const items = [];

      while (i < lines.length) {
        const curLine = lines[i];
        const curUl = curLine.match(/^([ \t]*)([\-\*])[ \t]+(.*)$/);
        const curOl = curLine.match(/^([ \t]*)(\d+)\.[ \t]+(.*)$/);
        const continuation = curLine.match(/^[ \t]{2,}([^ \t].*)$/);

        if ((isOrdered && curOl) || (!isOrdered && curUl)) {
          const itemText = isOrdered ? curOl[3] : curUl[3];
          items.push(itemText);
          i++;
        } else if (continuation && items.length > 0) {
          items[items.length - 1] += '\n' + continuation[1].trim();
          i++;
        } else {
          break;
        }
      }

      const listTag = isOrdered ? (firstNum !== 1 ? `<ol start="${firstNum}">` : '<ol>') : '<ul>';
      const listCloseTag = isOrdered ? '</ol>' : '</ul>';
      const itemHtmls = items.map(item => `<li>${renderInline(item, sourcePath, base, urlToPage, staticPaths, brokenLinks)}</li>`);
      blocks.push(`${listTag}\n${itemHtmls.join('\n')}\n${listCloseTag}`);
      continue;
    }

    // Paragraph: any other line, and lines after up to blank line, fence, heading, thematic break
    const paraLines = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (/^[ \t]*$/.test(cur)) break;
      if (/^```/.test(cur)) break;
      if (/^([ \t]*---[ \t]*|[ \t]*\*\*\*[ \t]*)$/.test(cur)) break;
      if (/^(#{1,6})[ \t]+/.test(cur)) break;
      // A list marker (or a > line) in the middle of a paragraph stays
      // paragraph text — a list/blockquote only starts at a block boundary.

      paraLines.push(cur.replace(/^[ \t]+|[ \t]+$/g, ''));
      i++;
    }
    if (paraLines.length > 0) {
      const paraText = paraLines.join('\n');
      const inline = renderInline(paraText, sourcePath, base, urlToPage, staticPaths, brokenLinks);
      blocks.push(`<p>${inline}</p>`);
    } else {
      i++;
    }
  }

  // Post-process heading IDs to make them unique in the page
  const idCounts = new Map();
  for (const h of toc) {
    let baseId = h.id;
    if (idCounts.has(baseId)) {
      const count = idCounts.get(baseId) + 1;
      idCounts.set(baseId, count);
      h.id = `${baseId}-${count}`;
    } else {
      idCounts.set(baseId, 1);
    }
  }

  // Re-render blocks with unique heading IDs if needed
  // (Alternatively, we can assign unique IDs during heading block processing, but since toc holds all headings in order, doing it here is very clean).
  // Let's rebuild blocks HTML with unique heading IDs:
  let blockIdx = 0;
  const finalBlocks = blocks.map(block => {
    if (/^<h[1-6]/.test(block)) {
      const hObj = toc[blockIdx++];
      return `<h${hObj.level} id="${hObj.id}">${renderInline(hObj.rawText, sourcePath, base, urlToPage, staticPaths, brokenLinks)}</h${hObj.level}>`;
    }
    return block;
  });

  const html = finalBlocks.map(b => b + '\n').join('');
  // Excerpt: the inner html of the body's FIRST top-level paragraph block.
  // (Not the first <p> in the html string — a <p> inside a <blockquote>
  // does not count.)
  let excerpt = '';
  for (const b of finalBlocks) {
    const pm = b.match(/^<p>([\s\S]*)<\/p>$/);
    if (pm) { excerpt = pm[1]; break; }
  }
  // toc is only the level 2 and 3 headings (spec: "toc (each level 2 and 3
  // heading: level, id, html)"); all headings still render as <hN> above.
  const tocResult = toc.filter(h => h.level === 2 || h.level === 3).map(h => ({
    level: h.level,
    id: h.id,
    html: renderInline(h.rawText, sourcePath, base, urlToPage, staticPaths, brokenLinks)
  }));

  return { html, toc: tocResult, excerpt };
}

function renderInline(text, sourcePath, base, urlToPage, staticPaths, brokenLinks) {
  // Parse inline elements: escapes, code, strong, emphasis, links, raw html / chars
  // To implement accurately and efficiently, we can parse token by token or regex scanner.
  // Let's implement an inline lexer/parser.
  let res = '';
  let i = 0;
  const len = text.length;
  // Literal run: consecutive plain characters are accumulated here and
  // escaped in one call, instead of one escapeHtml() call per character.
  let lit = '';
  const flushLit = () => {
    if (lit) { res += escapeHtml(lit); lit = ''; }
  };

  const escapeChars = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

  // A * at position j is a delimiter (not a literal) when it is not escaped.
  // A * is escaped exactly when preceded by an odd number of consecutive
  // backslashes (\\ is an escaped backslash, which escapes nothing).
  const isDelimStar = (j) => {
    if (j < 0 || j >= len || text[j] !== '*') return false;
    let n = 0;
    let k = j - 1;
    while (k >= 0 && text[k] === '\\') { n++; k--; }
    return n % 2 === 0;
  };
  // A * is a valid emphasis delimiter (opener or closer) when it is the last
  // star of a run of delimiter *s whose length is odd: in a run of 2 the
  // stars pair into **, in a run of 3 the first two pair into ** and the
  // third is single, and so on. So the last * of a *** run can close an
  // emphasis whose content holds the first **.
  const isEmphDelim = (j) => {
    if (!isDelimStar(j)) return false;
    if (isDelimStar(j + 1)) return false; // not the run's last star
    let n = 0;
    let k = j;
    while (isDelimStar(k)) { n++; k--; }
    return n % 2 === 1;
  };

  while (i < len) {
    const ch = text[i];

    // 1. Escape: \ before one of escapeChars writes that character escaped; any other \ is itself.
    if (ch === '\\' && i + 1 < len) {
      flushLit();
      const nextCh = text[i + 1];
      if (escapeChars.has(nextCh)) {
        res += escapeHtml(nextCh);
        i += 2;
        continue;
      } else {
        res += escapeHtml('\\');
        i += 1;
        continue;
      }
    }

    // 2. Code span: backtick closed by next backtick, at least 1 char between: <code>escaped</code>
    if (ch === '`') {
      flushLit();
      const closeIdx = text.indexOf('`', i + 1);
      if (closeIdx !== -1 && closeIdx - i > 1) {
        const codeContent = text.slice(i + 1, closeIdx);
        res += `<code>${escapeHtml(codeContent)}</code>`;
        i = closeIdx + 1;
        continue;
      } else {
        res += '`';
        i++;
        continue;
      }
    }

    // 3. Strong: ** ... ** closed by next ** not escaped, at least 1 char between
    if (ch === '*' && i + 1 < len && text[i + 1] === '*') {
      flushLit();
      // Find the next ** whose neither * is escaped (an escaped * is literal).
      let closeIdx = -1;
      let j = i + 2;
      while (j + 1 < len) {
        if (isDelimStar(j) && isDelimStar(j + 1)) { closeIdx = j; break; }
        j++;
      }
      if (closeIdx !== -1 && closeIdx - (i + 2) > 0) {
        const innerText = text.slice(i + 2, closeIdx);
        const innerHtml = renderInline(innerText, sourcePath, base, urlToPage, staticPaths, brokenLinks);
        res += `<strong>${innerHtml}</strong>`;
        i = closeIdx + 2;
        continue;
      } else {
        res += '**';
        i += 2;
        continue;
      }
    }

    // 4. Emphasis: single * closed by next single * (one not beside another *), at least 1 char between
    if (ch === '*') {
      flushLit();
      // Find the closing * : the next valid emphasis delimiter (last star
      // of an odd-length run of delimiter *s).
      let closeIdx = -1;
      let j = i + 1;
      while (j < len) {
        if (isEmphDelim(j)) {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx !== -1 && closeIdx - i > 1) {
        const innerText = text.slice(i + 1, closeIdx);
        const innerHtml = renderInline(innerText, sourcePath, base, urlToPage, staticPaths, brokenLinks);
        res += `<em>${innerHtml}</em>`;
        i = closeIdx + 1;
        continue;
      } else {
        res += '*';
        i++;
        continue;
      }
    }

    // 5. Link: [text](target)
    if (ch === '[') {
      flushLit();
      // The first ] not escaped closes the text (spec: "the first ] not
      // escaped closes the text") — no bracket-depth counting.
      let closeBracketIdx = -1;
      let j = i + 1;
      while (j < len) {
        if (text[j] === '\\' && j + 1 < len) {
          j += 2;
          continue;
        }
        if (text[j] === ']') { closeBracketIdx = j; break; }
        j++;
      }

      if (closeBracketIdx !== -1 && closeBracketIdx + 1 < len && text[closeBracketIdx + 1] === '(') {
        // The next ) (not escaped) closes the target.
        let closeParenIdx = -1;
        let k = closeBracketIdx + 2;
        while (k < len) {
          if (text[k] === '\\' && k + 1 < len) {
            k += 2;
            continue;
          }
          if (text[k] === ')') { closeParenIdx = k; break; }
          k++;
        }

        if (closeParenIdx !== -1) {
          const linkText = text.slice(i + 1, closeBracketIdx);
          const target = text.slice(closeBracketIdx + 2, closeParenIdx);

          // Target must not be empty or hold whitespace
          if (target !== '' && !/\s/.test(target)) {
            const resolvedHref = resolveLinkTarget(target, sourcePath, base, urlToPage, staticPaths, brokenLinks);
            const innerHtml = renderInline(linkText, sourcePath, base, urlToPage, staticPaths, brokenLinks);
            res += `<a href="${escapeHtml(resolvedHref)}">${innerHtml}</a>`;
            i = closeParenIdx + 1;
            continue;
          }
        }
      }

      res += '[';
      i++;
      continue;
    }

    // Default character: accumulate into the literal run.
    lit += ch;
    i++;
  }

  flushLit();
  return res;
}

function resolveLinkTarget(target, sourcePath, base, urlToPage, staticPaths, brokenLinks) {
  // Href with scheme (e.g. https:, mailto:), opening on /, or opening on # kept as written.
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
    return target;
  }

  // Split fragment
  let pathPart = target;
  let fragment = '';
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) {
    pathPart = target.slice(0, hashIdx);
    fragment = target.slice(hashIdx);
  }

  // Path from source directory (. and .. steps, never above root)
  const sourceDir = getDirectory(sourcePath);
  const parts = sourceDir ? sourceDir.split('/') : [];
  
  if (pathPart !== '') {
    const segments = pathPart.split('/');
    for (const seg of segments) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length > 0) parts.pop();
      } else {
        parts.push(seg);
      }
    }
  }

  const resolvedPath = parts.join('/');

  // Check if resolvedPath is a built page or static file.
  // The target names a source: either the resolved path itself (when it
  // already ends in .md) or the resolved path with .md appended.
  const candidatePaths = [];
  if (resolvedPath) {
    candidatePaths.push(resolvedPath);
    if (!resolvedPath.endsWith('.md')) candidatePaths.push(`${resolvedPath}.md`);
  }

  // Find page whose source path is one of the candidates.
  let foundPage = null;
  for (const cand of candidatePaths) {
    for (const page of urlToPage.values()) {
      if (page.path === cand) { foundPage = page; break; }
    }
    if (foundPage) break;
  }

  if (foundPage) {
    // fragment already includes the leading '#'; it goes after the url.
    return foundPage.url + fragment;
  }

  // Check if static file
  if (staticPaths.has(resolvedPath)) {
    return (base === '' ? `/${resolvedPath}` : `${base}/${resolvedPath}`) + fragment;
  }

  // Target that names neither is reported as a broken link and kept as written
  brokenLinks.add(`broken-link ${sourcePath} -> ${target}`);
  return target;
}

// --- Template Engine ---

function parseTemplate(name, src, reportError) {
  // Parse template syntax into AST
  // Tags: {{ path }}, {{{ path }}}, {% for x in path %} ... {% endfor %}, {% if path %} ... {% else %} ... {% endif %}, {% if not path %}, {% include "name" %}
  // Tag alone on line removes whole line including \n.

  // First, handle lines with tags alone on line
  const lines = src.split('\n');
  const processedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only a {% %} tag alone on its line takes the whole line (spec:
    // "Text, {{ }} and {{{ }}} never do"). A line counts as tag-alone only
    // when, ignoring leading/trailing spaces/tabs, it is exactly ONE {%
    // ... %} tag: the tag's content must not contain another %} (the tag
    // closes at the FIRST %}), so a line like
    // "{% if page %}<meta ...>{% endif %}" is NOT alone.
    const tagAloneMatch = line.match(/^[ \t]*(\{%(?:(?!%\})[\s\S])*?%\})[ \t]*$/);
    if (tagAloneMatch) {
      processedLines.push({ text: tagAloneMatch[1], alone: true });
    } else {
      processedLines.push({ text: line, alone: false });
    }
  }

  // Reassemble string or tokenize
  // Actually, let's parse text into tokens: literal text, expr {{}}, raw {{{}}}, tag {%%}
  const tokens = [];
  
  // Let's parse the template string (with alone line handling)
  // If a line is alone, its \n is included (i.e. removed from output spacing).
  
  let code = '';
  for (let idx = 0; idx < processedLines.length; idx++) {
    const pl = processedLines[idx];
    if (pl.alone && idx < processedLines.length - 1) {
      // A {% %} tag alone on its line takes the whole line with it, its \n
      // included: emit the tag but NOT the \n after it.
      code += pl.text;
    } else {
      code += pl.text + (idx < processedLines.length - 1 ? '\n' : '');
    }
  }

  // Tokenizer for template
  const ast = parseTokens(code, name, reportError);
  return ast;
}

function parseTokens(code, templateName, reportError) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // Look for {{, {{{, or {%
    const nextOpen = code.indexOf('{{', i);
    const nextTag = code.indexOf('{%', i);

    let idx = -1;
    let type = '';

    if (nextOpen !== -1 && nextTag !== -1) {
      if (nextOpen < nextTag) {
        idx = nextOpen;
        type = code.startsWith('{{{', nextOpen) ? 'raw' : 'expr';
      } else {
        idx = nextTag;
        type = 'tag';
      }
    } else if (nextOpen !== -1) {
      idx = nextOpen;
      type = code.startsWith('{{{', nextOpen) ? 'raw' : 'expr';
    } else if (nextTag !== -1) {
      idx = nextTag;
      type = 'tag';
    }

    if (idx === -1) {
      // Rest is literal text
      if (i < len) {
        tokens.push({ type: 'literal', value: code.slice(i) });
      }
      break;
    }

    if (idx > i) {
      tokens.push({ type: 'literal', value: code.slice(i, idx) });
    }

    if (type === 'raw') {
      const closeIdx = code.indexOf('}}}', idx);
      if (closeIdx === -1) {
        throw new Error('unclosed "{{{"');
      }
      const expr = code.slice(idx + 3, closeIdx).trim();
      tokens.push({ type: 'raw', path: parsePath(expr) });
      i = closeIdx + 3;
    } else if (type === 'expr') {
      const closeIdx = code.indexOf('}}', idx);
      if (closeIdx === -1) {
        throw new Error('unclosed "{{"');
      }
      const expr = code.slice(idx + 2, closeIdx).trim();
      tokens.push({ type: 'expr', path: parsePath(expr) });
      i = closeIdx + 2;
    } else if (type === 'tag') {
      const closeIdx = code.indexOf('%}', idx);
      if (closeIdx === -1) {
        throw new Error('unclosed "{%"');
      }
      const tagContent = code.slice(idx + 2, closeIdx).trim();
      const tagTokens = tagContent.split(/\s+/);
      const tagName = tagTokens[0];

      if (tagName === 'for') {
        // {% for x in path %}
        if (tagTokens.length !== 4 || tagTokens[2] !== 'in') {
          throw new Error('invalid for syntax');
        }
        const variable = tagTokens[1];
        const pathExpr = tagTokens[3];
        tokens.push({ type: 'for', variable, path: parsePath(pathExpr), children: [] });
      } else if (tagName === 'endfor') {
        tokens.push({ type: 'endfor' });
      } else if (tagName === 'if') {
        // {% if path %} or {% if not path %}
        let isNot = false;
        let pathStr = '';
        if (tagTokens[1] === 'not') {
          isNot = true;
          pathStr = tagTokens[2];
        } else {
          pathStr = tagTokens[1];
        }
        tokens.push({ type: 'if', isNot, path: parsePath(pathStr), children: [], elseChildren: null });
      } else if (tagName === 'else') {
        tokens.push({ type: 'else' });
      } else if (tagName === 'endif') {
        tokens.push({ type: 'endif' });
      } else if (tagName === 'include') {
        // {% include "name" %}
        const includeArg = tagContent.slice(7).trim();
        const match = includeArg.match(/^"([^"]+)"$/) || includeArg.match(/^'([^']+)'$/);
        if (!match) {
          throw new Error('invalid include syntax');
        }
        tokens.push({ type: 'include', templateName: match[1] });
      } else {
        throw new Error(`unknown tag "${tagName}"`);
      }

      i = closeIdx + 2;
    }
  }

  // Build tree from flat tokens
  return buildAst(tokens);
}

function parsePath(expr) {
  // Path: names joined by . (a-z, A-Z, 0-9, _, from letter or _)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(expr)) {
    throw new Error(`invalid path "${expr}"`);
  }
  return expr.split('.');
}

function buildAst(flatTokens) {
  const root = { type: 'root', children: [] };
  const stack = [root];

  for (const token of flatTokens) {
    const parent = stack[stack.length - 1];

    if (token.type === 'for' || token.type === 'if') {
      stack.push(token);
    } else if (token.type === 'endfor') {
      const node = stack.pop();
      if (!node || node.type !== 'for') {
      throw new Error('unexpected endfor');
      }
      stack[stack.length - 1].children.push(node);
    } else if (token.type === 'endif') {
      const node = stack.pop();
      if (!node || node.type !== 'if') {
        throw new Error('unexpected endif');
      }
      stack[stack.length - 1].children.push(node);
    } else if (token.type === 'else') {
      const node = stack[stack.length - 1];
      if (!node || node.type !== 'if') {
        throw new Error('unexpected else');
      }
      node.elseChildren = [];
    } else {
      if (parent.elseChildren) {
        parent.elseChildren.push(token);
      } else {
        parent.children.push(token);
      }
    }
  }

  if (stack.length > 1) {
    throw new Error('unclosed block');
  }

  return root;
}

function resolvePathValue(pathArr, scope, loopStack) {
  // First name read from innermost loop that binds it (loop before element), else from page values.
  const firstName = pathArr[0];

  let currentVal = undefined;
  let found = false;

  // Check loop stack from inner to outer
  for (let i = loopStack.length - 1; i >= 0; i--) {
    const loopCtx = loopStack[i];
    if (firstName === 'loop') {
      currentVal = loopCtx.loop;
      found = true;
      break;
    }
    if (firstName === loopCtx.variable) {
      currentVal = loopCtx.item;
      found = true;
      break;
    }
  }

  if (!found) {
    if (firstName in scope) {
      currentVal = scope[firstName];
      found = true;
    }
  }

  if (!found) return undefined;

  // Resolve subsequent names as own property
  for (let j = 1; j < pathArr.length; j++) {
    const prop = pathArr[j];
    if (currentVal !== null && (typeof currentVal === 'object' || typeof currentVal === 'function')) {
      if (Object.prototype.hasOwnProperty.call(currentVal, prop)) {
        currentVal = currentVal[prop];
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  return currentVal;
}

function isTruthy(val) {
  if (val === undefined || val === null || val === false || val === '') return false;
  if (typeof val === 'number' && val === 0) return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

function formatValueForOutput(val) {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    return val.map(formatValueForOutput).join(', ');
  }
  return '';
}

function renderTemplate(astNode, scope, parsedTemplates, reportError, loopStack = [], includeDepth = 0) {
  let output = '';

  for (const child of astNode.children) {
    if (child.type === 'literal') {
      output += child.value;
    } else if (child.type === 'expr') {
      const val = resolvePathValue(child.path, scope, loopStack);
      output += escapeHtml(formatValueForOutput(val));
    } else if (child.type === 'raw') {
      const val = resolvePathValue(child.path, scope, loopStack);
      output += formatValueForOutput(val);
    } else if (child.type === 'for') {
      const val = resolvePathValue(child.path, scope, loopStack);
      if (Array.isArray(val)) {
        const length = val.length;
        for (let idx = 0; idx < length; idx++) {
          const item = val[idx];
          const loopObj = {
            index: idx + 1,
            first: idx === 0,
            last: idx === length - 1,
            length: length
          };
          loopStack.push({ variable: child.variable, item, loop: loopObj });
          output += renderTemplate(child, scope, parsedTemplates, reportError, loopStack, includeDepth);
          loopStack.pop();
        }
      }
    } else if (child.type === 'if') {
      const val = resolvePathValue(child.path, scope, loopStack);
      const condition = child.isNot ? !isTruthy(val) : isTruthy(val);
      if (condition) {
        // create a temporary node with children as children
        output += renderTemplate({ children: child.children }, scope, parsedTemplates, reportError, loopStack, includeDepth);
      } else if (child.elseChildren) {
        output += renderTemplate({ children: child.elseChildren }, scope, parsedTemplates, reportError, loopStack, includeDepth);
      }
    } else if (child.type === 'include') {
      if (includeDepth >= 8) {
        // max depth 8, renders nothing
        continue;
      }
      const inclTemplate = parsedTemplates.get(child.templateName);
      if (inclTemplate) {
        output += renderTemplate(inclTemplate, scope, parsedTemplates, reportError, loopStack, includeDepth + 1);
      } else {
        // missing template renders nothing
        continue;
      }
    }
  }

  return output;
}
