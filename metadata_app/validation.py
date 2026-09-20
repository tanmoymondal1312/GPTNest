import re
import unicodedata


# ── Singular/Plural normalization map ──
_SINGULAR_MAP = {
    'leaves': 'leaf', 'flies': 'fly', 'wives': 'wife', 'knives': 'knife',
    'thieves': 'thief', 'wolves': 'wolf', 'lives': 'life', 'halves': 'half',
    'classes': 'class', 'churches': 'church', 'boxes': 'box', 'foxes': 'fox',
    'potatoes': 'potato', 'tomatoes': 'tomato', 'heroes': 'hero', 'echoes': 'echo',
    'analyses': 'analysis', 'bases': 'base', 'crises': 'crisis', 'oases': 'oasis',
    'theses': 'thesis', 'phenomena': 'phenomenon', 'criteria': 'criterion',
    'data': 'datum', 'medium': 'medium', 'bacteria': 'bacterium',
    'geese': 'goose', 'mice': 'mouse', 'teeth': 'tooth', 'feet': 'foot',
    'men': 'man', 'women': 'woman', 'children': 'child', 'people': 'person',
    'dice': 'die', 'lice': 'louse', 'oxen': 'ox', 'sheep': 'sheep',
    'deer': 'deer', 'fish': 'fish', 'species': 'species', 'series': 'series',
}

_PLURAL_SUFFIXES = [
    (r'(?<!s)s$', ''),          # cats -> cat (but not bus)
    (r'ies$', 'y'),             # cities -> city
    (r'(?<=e)s$', ''),          # leaves -> leave (then map)
    (r'(?<![^aeiou])es$', ''),  # boxes -> box
    (r'(?<=[^aeiou])es$', ''),  # churches -> church
    (r'ves$', 'fe'),            # knives -> knive -> knife (via map)
]


def _escape_regex(string):
    return re.sub(r'[.*+?^${}()|[\]\\]', r'\\$&', string)


def _normalize_keyword(kw):
    """Normalize a single keyword: trim, lowercase, strip punctuation, normalize unicode."""
    kw = kw.strip().lower()
    kw = unicodedata.normalize('NFKD', kw)
    kw = re.sub(r'^[,\.\-_:;!\?\'\"]+|[,\.\-_:;!\?\'\"]+$', '', kw)
    kw = re.sub(r'\s+', ' ', kw)
    return kw


def _singular_form(word):
    """Get singular form if a common plural variant exists."""
    if word in _SINGULAR_MAP:
        return _SINGULAR_MAP[word]
    for pattern, replacement in _PLURAL_SUFFIXES:
        singular = re.sub(pattern, replacement, word)
        if singular != word and len(singular) >= 3:
            return singular
    return word


def _is_prohibited(text, prohibited_list):
    if not prohibited_list:
        return False
    lower = text.lower()
    return any(
        re.search(r'\b' + _escape_regex(p) + r'\b', lower)
        for p in prohibited_list
    )


def _is_generic_filler(word):
    """Detect obviously generic/irrelevant filler keywords."""
    filler = {
        'image', 'photo', 'picture', 'graphic', 'design', 'illustration',
        'vector', 'artwork', 'file', 'digital', 'creative', 'beautiful',
        'amazing', 'professional', 'high', 'quality', 'stock', 'eps',
        'abstract', 'background', 'texture', 'pattern', 'element',
        'icon', 'symbol', 'logo', 'banner', 'template', 'layout',
    }
    return word in filler


def normalize_keywords(keywords, settings, max_allowed=49):
    """
    Deterministic keyword normalization pipeline.
    Returns list of normalized, deduplicated, relevance-ordered keywords.
    """
    prohibited_list = []
    if settings.get('prohibitedWordsEnabled'):
        prohibited_list = [
            w.strip().lower()
            for w in re.split(r'[,;\n]+', settings.get('prohibitedWordsText', ''))
            if w.strip()
        ]

    single_word_mode = settings.get('singleWordKeywords', True)
    seen = set()
    seen_singulars = set()
    result = []

    for raw_kw in keywords:
        if not raw_kw or not isinstance(raw_kw, str):
            continue

        kw = _normalize_keyword(raw_kw)
        if not kw or len(kw) < 2:
            continue

        if _is_prohibited(kw, prohibited_list):
            continue

        # Split multi-word keywords in single-word mode
        if single_word_mode and ' ' in kw:
            parts = [w for w in kw.split() if len(w) > 2]
            for part in parts:
                if _is_prohibited(part, prohibited_list):
                    continue
                if part in seen:
                    continue
                singular = _singular_form(part)
                if singular in seen_singulars:
                    continue
                seen.add(part)
                seen_singulars.add(singular)
                result.append(part)
            continue

        # Singular/plural dedup
        singular = _singular_form(kw)
        if singular in seen_singulars and kw not in seen:
            continue

        if kw in seen:
            continue

        seen.add(kw)
        seen_singulars.add(singular)
        result.append(kw)

        if len(result) >= max_allowed:
            break

    return result


def sanitize_and_validate_metadata(title, description, keywords, settings, max_allowed_keywords=49):
    """Validate and clean metadata. Returns cleaned metadata + quality report."""
    issues = []

    # ── Title cleaning ──
    clean_title = re.sub(r'\s+', ' ', title.strip()) if title else ''

    # Remove generic prefixes
    generic_prefix_regex = re.compile(
        r'^(eps\s+vector\s+(of|with|illustration|graphic)?|'
        r'vector\s+(illustration\s+of|artwork\s+of|graphic\s+of|of|isolated|design\s+of)?|'
        r'illustration\s+(of|with)?|'
        r'graphic\s+design\s+(of)?|'
        r'stock\s+(vector|image|photo|illustration)\s+(of)?)\s+',
        re.IGNORECASE,
    )
    m = generic_prefix_regex.match(clean_title)
    if m:
        stripped = clean_title[m.end():].strip()
        if len(stripped) > 5:
            clean_title = stripped[0].upper() + stripped[1:]

    # Remove prohibited words from title
    prohibited_list = []
    if settings.get('prohibitedWordsEnabled'):
        prohibited_list = [
            w.strip().lower()
            for w in re.split(r'[,;\n]+', settings.get('prohibitedWordsText', ''))
            if w.strip()
        ]
    for pw in prohibited_list:
        regex = re.compile(r'\b' + _escape_regex(pw) + r'\b', re.IGNORECASE)
        if regex.search(clean_title):
            clean_title = regex.sub('', clean_title)
            clean_title = re.sub(r'\s+', ' ', clean_title).strip()

    title_words = clean_title.split() if clean_title else []
    if len(title_words) < settings.get('minTitleWords', 8):
        issues.append(f"Title has {len(title_words)} words (minimum: {settings.get('minTitleWords', 8)})")
    if len(title_words) > settings.get('maxTitleWords', 22):
        issues.append(f"Title has {len(title_words)} words (maximum: {settings.get('maxTitleWords', 22)})")

    # ── Description cleaning ──
    clean_description = re.sub(r'\s+', ' ', description.strip()) if description else ''
    for pw in prohibited_list:
        regex = re.compile(r'\b' + _escape_regex(pw) + r'\b', re.IGNORECASE)
        if regex.search(clean_description):
            clean_description = regex.sub('', clean_description)
            clean_description = re.sub(r'\s+', ' ', clean_description).strip()

    desc_words = clean_description.split() if clean_description else []
    if len(desc_words) < settings.get('minDescriptionWords', 18):
        issues.append(f"Description has {len(desc_words)} words (minimum: {settings.get('minDescriptionWords', 18)})")

    # ── Keyword normalization ──
    clean_keywords = normalize_keywords(keywords, settings, max_allowed_keywords)

    if len(clean_keywords) < settings.get('minKeywords', 25):
        issues.append(f"Keyword count ({len(clean_keywords)}) below target min ({settings.get('minKeywords', 25)})")

    # ── Quality scores ──
    accuracy = 96
    if len(title_words) < 5:
        accuracy -= 10
    elif len(title_words) < settings.get('minTitleWords', 8):
        accuracy -= 5
    if len(clean_keywords) < 15:
        accuracy -= 8
    if not clean_title:
        accuracy -= 15
    if not clean_description:
        accuracy -= 10

    relevance = 94
    if settings.get('minTitleWords', 8) <= len(title_words) <= settings.get('maxTitleWords', 22):
        relevance += 2
    else:
        relevance -= 4
    if len(desc_words) >= settings.get('minDescriptionWords', 18):
        relevance += 2
    else:
        relevance -= 3

    kw_ratio = min(1, len(clean_keywords) / min(49, settings.get('maxKeywords', 49)))
    seo_potential = round(75 + kw_ratio * 23)
    if len(clean_keywords) >= 40:
        seo_potential = min(99, seo_potential + 2)

    accuracy = max(60, min(99, round(accuracy)))
    relevance = max(60, min(99, round(relevance)))
    seo_potential = max(60, min(99, round(seo_potential)))

    return {
        'cleanTitle': clean_title,
        'cleanDescription': clean_description,
        'cleanKeywords': clean_keywords,
        'qualityScore': {
            'accuracy': accuracy,
            'relevance': relevance,
            'seoPotential': seo_potential,
        },
        'report': {
            'valid': len(issues) == 0,
            'issues': issues,
            'keywordCount': len(clean_keywords),
            'titleWordCount': len(title_words),
            'descriptionWordCount': len(desc_words),
        },
    }


def adapt_metadata_for_platform(analysis, base_metadata, platform_id, settings):
    """
    Adapt metadata for a specific platform.
    IMPORTANT: Uses AI-generated keywords as primary source.
    Only supplements from analysis if keywords are critically low.
    Never destroys AI relevance ordering.
    """
    from .platforms import PLATFORMS

    platform_config = PLATFORMS.get(platform_id, PLATFORMS['adobe-stock'])
    max_keywords = min(settings.get('maxKeywords', 49), platform_config['maxKeywords'])

    # Primary source: AI-generated keywords
    ai_keywords = base_metadata.get('keywords', []) or []

    # If AI gave very few keywords, supplement from analysis
    supplementary = []
    if len(ai_keywords) < 10:
        if analysis.get('main_subject'):
            supplementary.extend(analysis['main_subject'].lower().split())
        if analysis.get('objects'):
            supplementary.extend(o.lower() for o in analysis['objects'])
        if analysis.get('style'):
            supplementary.append(analysis['style'].lower())
        if analysis.get('content_type'):
            supplementary.append(analysis['content_type'].lower())
        if analysis.get('theme'):
            supplementary.append(analysis['theme'].lower())
        if analysis.get('colors'):
            supplementary.extend(c.lower() for c in analysis['colors'])

    # Merge: AI keywords first (preserving order), then supplementary
    merged = list(ai_keywords)
    for s in supplementary:
        if s not in [k.lower() for k in merged]:
            merged.append(s)

    # Normalize and enforce platform limits
    result = sanitize_and_validate_metadata(
        base_metadata.get('title', ''),
        base_metadata.get('description', ''),
        merged,
        settings,
        max_keywords,
    )

    return {
        'title': result['cleanTitle'],
        'description': result['cleanDescription'],
        'keywords': result['cleanKeywords'],
        'primaryCategory': base_metadata.get('category', 'Graphic Resources'),
        'secondaryCategory': base_metadata.get('secondary_category', 'Illustration'),
        'qualityScore': result['qualityScore'],
        'validation': result['report'],
    }


def validate_metadata_complete(item):
    """
    Validate that a file's metadata is complete and ready for export.
    Returns (is_valid, list_of_issues).
    """
    issues = []

    if not item.get('fileName'):
        issues.append('Missing filename')
    if not item.get('title') or len(item['title'].strip()) < 3:
        issues.append('Title is empty or too short')
    if not item.get('description') or len(item['description'].strip()) < 10:
        issues.append('Description is empty or too short')
    if not item.get('keywords') or len(item['keywords']) == 0:
        issues.append('No keywords')
    if not item.get('primaryCategory'):
        issues.append('Missing category')

    # Check title isn't generic
    title_lower = (item.get('title') or '').lower().strip()
    generic_starts = ['vector', 'eps', 'graphic', 'illustration', 'stock', 'design', 'image', 'photo', 'picture']
    for gs in generic_starts:
        if title_lower.startswith(gs + ' ') and len(title_lower.split()) < 6:
            issues.append(f'Title starts with generic prefix: "{gs}"')
            break

    # Check keywords aren't all generic
    if item.get('keywords'):
        generic_count = sum(1 for kw in item['keywords'] if _is_generic_filler(kw))
        if generic_count > len(item['keywords']) * 0.5:
            issues.append('Too many generic filler keywords')

    return (len(issues) == 0, issues)
