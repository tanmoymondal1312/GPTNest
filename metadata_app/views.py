import json
import logging
import re

from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.contrib import messages
from django.http import JsonResponse
from django.shortcuts import render, redirect
from django.views.decorators.csrf import csrf_exempt

from .gemini_client import (
    GEMINI_MODEL,
    get_gemini_client,
    classify_ai_error,
    generate_content_with_retry,
    get_cached_analysis,
    set_cached_analysis,
)
from .eps_renderer import render_eps_to_png
from .platforms import PLATFORMS
from .validation import (
    adapt_metadata_for_platform,
    sanitize_and_validate_metadata,
    normalize_keywords,
    validate_metadata_complete,
)

logger = logging.getLogger(__name__)

GENAI_SCHEMA = {
    'response_mime_type': 'application/json',
    'response_schema': {
        'type': 'object',
        'properties': {
            'analysis': {
                'type': 'object',
                'properties': {
                    'main_subject': {'type': 'string', 'description': 'The single most important core subject visibly present in the artwork'},
                    'secondary_subjects': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Other notable subjects visible but secondary to the main subject'},
                    'objects': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Inventory of all major and secondary visible objects'},
                    'actions': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Actions or activities visibly occurring'},
                    'environment': {'type': 'string', 'description': 'Inferable environment or location based ONLY on visible evidence'},
                    'visible_text': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Exact text visibly printed/drawn in the artwork'},
                    'style': {'type': 'string', 'description': 'Artistic and visual style'},
                    'theme': {'type': 'string', 'description': 'Theme or conceptual context'},
                    'colors': {'type': 'array', 'items': {'type': 'string'}, 'description': 'List of dominant visible colors'},
                    'background': {'type': 'string', 'description': 'Background description'},
                    'composition': {'type': 'string', 'description': 'Composition layout'},
                    'perspective': {'type': 'string', 'description': 'Camera angle or perspective'},
                    'lighting': {'type': 'string', 'description': 'Lighting characteristics'},
                    'content_type': {'type': 'string', 'description': 'Content type classification'},
                    'confidence': {'type': 'integer', 'description': 'Visual recognition confidence percentage (0 to 100)'},
                },
                'required': ['main_subject', 'objects', 'visible_text', 'style', 'theme', 'colors', 'background', 'composition', 'content_type', 'confidence'],
            },
            'metadata': {
                'type': 'object',
                'properties': {
                    'title': {'type': 'string', 'description': 'SEO-optimized stock title describing the actual visible subject'},
                    'description': {'type': 'string', 'description': 'Complete commercial stock description of the visible content'},
                    'keywords': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Relevance-ranked keywords, strongest first'},
                    'category': {'type': 'string', 'description': 'Primary microstock category'},
                    'secondary_category': {'type': 'string', 'description': 'Secondary related microstock category'},
                },
                'required': ['title', 'description', 'keywords', 'category', 'secondary_category'],
            },
        },
        'required': ['analysis', 'metadata'],
    },
}

PROMPT_SCHEMA = {
    'response_mime_type': 'application/json',
    'response_schema': {
        'type': 'object',
        'properties': {
            'prompt': {'type': 'string', 'description': 'Complete positive prompt'},
            'negativePrompt': {'type': 'string', 'description': 'Optimized negative prompt'},
            'style': {'type': 'string', 'description': 'Artistic medium and style descriptor'},
            'lighting': {'type': 'string', 'description': 'Lighting setup'},
            'composition': {'type': 'string', 'description': 'Compositional structure'},
            'camera': {'type': 'string', 'description': 'Camera lens, angle, and viewpoint'},
            'colors': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Dominant color palette'},
            'aspectRatio': {'type': 'string', 'description': 'Estimated aspect ratio'},
            'parameters': {'type': 'string', 'description': 'Standard Midjourney / SD parameters'},
        },
        'required': ['prompt', 'negativePrompt', 'style', 'lighting', 'composition', 'camera', 'colors', 'aspectRatio', 'parameters'],
    },
}


def landing(request):
    return render(request, 'landing.html')


def login_page(request):
    if request.user.is_authenticated:
        return redirect('index')

    signup_mode = request.GET.get('mode') == 'signup'
    ctx = {'signup_mode': signup_mode}

    if request.method == 'POST':
        action = request.POST.get('action', 'login')
        email = request.POST.get('email', '').strip()
        password = request.POST.get('password', '')

        if action == 'signup':
            name = request.POST.get('name', '').strip()
            if not email or not password:
                messages.error(request, 'Email and password are required.')
                return render(request, 'login.html', ctx)
            if User.objects.filter(email=email).exists():
                messages.error(request, 'An account with this email already exists.')
                return render(request, 'login.html', ctx)
            user = User.objects.create_user(
                username=email,
                email=email,
                password=password,
                first_name=name,
            )
            login(request, user)
            return redirect('index')
        else:
            if not email or not password:
                messages.error(request, 'Email and password are required.')
                return render(request, 'login.html', ctx)
            user = authenticate(request, username=email, password=password)
            if user is not None:
                login(request, user)
                next_url = request.GET.get('next', 'index')
                return redirect(next_url)
            else:
                messages.error(request, 'Invalid email or password.')
                return render(request, 'login.html', ctx)

    return render(request, 'login.html', ctx)


def logout_view(request):
    logout(request)
    return redirect('landing')


@login_required
def index(request):
    return render(request, 'tool.html')


def _build_system_instruction(settings):
    min_title = settings.get('minTitleWords', 8)
    max_title = settings.get('maxTitleWords', 22)
    min_kw = settings.get('minKeywords', 25)
    max_kw = settings.get('maxKeywords', 49)
    min_desc = settings.get('minDescriptionWords', 18)
    max_desc = settings.get('maxDescriptionWords', 32)
    single_word = settings.get('singleWordKeywords', True)
    custom_prompt = settings.get('customPromptText', '') if settings.get('customPromptEnabled') else ''
    prohibited = settings.get('prohibitedWordsText', '') if settings.get('prohibitedWordsEnabled') else ''

    return f"""You are a professional microstock metadata visual analyst and commercial taxonomist.

═══ CRITICAL DIRECTIVES ═══

1. TWO-STAGE ANALYSIS ARCHITECTURE:
   - STAGE 1 (VISUAL INSPECTION): Perform an exhaustive, pixel-based visual inspection. Identify the main subject, secondary subjects, every clearly visible object, people characteristics (if visible), animals (if visible), actions, environment (if inferable from visible evidence only), visible text (OCR), artistic style, theme, dominant colors, background, composition, perspective, lighting, and content type. Assess confidence (0-100). DO NOT infer objects not visibly present.
   - STAGE 2 (METADATA GENERATION): Generate title, description, keywords, and categories EXCLUSIVELY from the Stage 1 visual inventory. Every piece of metadata must be traceable to something visibly observed.

2. ABSOLUTE ANTI-HALLUCINATION RULES:
   - Base ALL analysis strictly on what is visibly present in the pixels.
   - NEVER use the filename as evidence of content.
   - NEVER infer scenes from objects (e.g., do NOT add "office worker" just because a laptop is visible; do NOT add "coffee shop" just because a cup is visible).
   - NEVER invent brand names, company names, copyrighted characters, celebrity names, artist names, or trademarked terms.
   - NEVER invent locations, events, or actions not visibly supported.
   - If visual evidence is ambiguous, DO NOT guess. Omit uncertain elements.
   - Accuracy is paramount over volume. Fewer accurate keywords are better than many hallucinated ones.

3. VISIBLE TEXT & OCR:
   - Read actual visible text verbatim.
   - If no readable text is present, visible_text MUST be empty [].
   - If placeholder text like "YOUR TEXT", "LOREM IPSUM", or "SAMPLE TEXT" appears, note it but DO NOT treat it as the artwork's subject.

4. TITLE SPECIFICATION:
   - Structure: [Primary Subject] + [Specific Context/Action/Appearance] + [Relevant Visual Context]
   - Length: {min_title} to {max_title} words.
   - The title MUST start with the most important visible subject.
   - MUST be specific enough for stock image search.
   - MUST be natural human-readable English.
   - NEVER start with: "EPS", "Vector", "Artwork", "Graphic", "Template", "Design", "Illustration", "Beautiful", "Amazing", "Creative", "Professional", "High Quality" — unless genuinely necessary to describe the subject.
   - For a red apple: "Red Apple Isolated on White Background" (NOT "Beautiful Fruit Illustration")

5. DESCRIPTION SPECIFICATION:
   - Length: {min_desc} to {max_desc} words.
   - Describe what is ACTUALLY visible in the image.
   - Mention the primary subject, important visible context, and relevant searchable concepts.
   - Be commercially useful for stock marketplaces.
   - Avoid keyword stuffing.
   - Never produce generic filler like "High quality image suitable for various purposes."

6. KEYWORD SPECIFICATION & STRICT RELEVANCE RANKING:
   - Generate keywords ranked by search relevance — STRONGEST FIRST.
   - Relevance hierarchy: (1) Primary subject, (2) Key objects, (3) Subject characteristics, (4) Action/activity, (5) Environment, (6) Theme/concept, (7) Style, (8) Composition, (9) Visual characteristics, (10) Supporting terms.
   - Maximum {max_kw} keywords. If only 15-25 genuinely accurate keywords exist, return only those. Do NOT pad with generic filler.
   - {"Prioritize single-word keywords where meaningful, but keep essential multi-word phrases." if single_word else "Multi-word phrases and single words are both permitted where natural."}
   - NEVER include keywords not supported by the visual content.
   - {"PROHIBITED WORDS (never use these): [" + prohibited + "]." if prohibited else ""}
   {"- CUSTOM INSTRUCTION: \"" + custom_prompt + "\" (apply strictly to visually supported elements only)." if custom_prompt else ""}

═══ OUTPUT FORMAT ═══

Return JSON with:
- "analysis": the complete visual inventory from Stage 1
- "metadata": stock metadata generated strictly from the visual inventory

The metadata keywords MUST be ranked by search relevance, NOT alphabetically."""


def _post_process_metadata(parsed):
    """
    Post-process AI response: normalize keywords, validate, ensure consistency.
    Returns (processed_dict, is_valid, issues).
    """
    analysis = parsed.get('analysis') or parsed.get('visual_analysis') or {}
    metadata = parsed.get('metadata', {})

    # Ensure analysis aliases
    if 'analysis' in parsed and not parsed.get('visual_analysis'):
        parsed['visual_analysis'] = parsed['analysis']
    elif 'visual_analysis' in parsed and not parsed.get('analysis'):
        parsed['analysis'] = parsed['visual_analysis']

    # Normalize keywords
    raw_keywords = metadata.get('keywords', [])
    if isinstance(raw_keywords, list):
        normalized = normalize_keywords(raw_keywords, {'singleWordKeywords': True}, 49)
        metadata['keywords'] = normalized

    # Clean title
    title = (metadata.get('title') or '').strip()
    title = re.sub(r'\s+', ' ', title)
    metadata['title'] = title

    # Clean description
    desc = (metadata.get('description') or '').strip()
    desc = re.sub(r'\s+', ' ', desc)
    metadata['description'] = desc

    parsed['analysis'] = analysis
    parsed['metadata'] = metadata

    # Validate completeness
    validation_item = {
        'fileName': '_ai_response_',
        'title': title,
        'description': desc,
        'keywords': metadata.get('keywords', []),
        'primaryCategory': metadata.get('category', ''),
    }
    is_valid, issues = validate_metadata_complete(validation_item)

    return parsed, is_valid, issues


@csrf_exempt
async def analyze_metadata(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Invalid request method'}, status=405)

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    image = body.get('image')
    if not image:
        return JsonResponse({'error': 'Image base64 data is required for visual analysis.'}, status=400)

    mime_type = body.get('mimeType', 'image/png')
    file_name = body.get('fileName', '')
    platform = body.get('platform', 'adobe-stock')
    settings = body.get('settings', {})
    file_hash = body.get('fileHash', '')
    requested_model = body.get('model', '')

    cached, cache_key = get_cached_analysis(file_hash, image)
    if cached:
        logger.info(f'[AI Vision Cache Hit] Reusing visual analysis for {file_name or "artwork"}')
        return JsonResponse(cached)

    try:
        client = get_gemini_client()
    except ValueError as e:
        return JsonResponse({'error': str(e)}, status=500)

    system_instruction = _build_system_instruction(settings)
    user_prompt = """Perform a deep 2-stage visual analysis of this rendered artwork.

STAGE 1 — VISUAL INSPECTION:
Exhaustively inventory every visible element: main subject, secondary subjects, all visible objects, people (if present), animals (if present), actions, environment (if inferable), visible text (OCR), artistic style, theme, dominant colors, background, composition, perspective, lighting, and content type. Assign a confidence percentage.

STAGE 2 — METADATA GENERATION:
From your Stage 1 visual inventory ONLY, generate:
- A specific, searchable title (no generic prefixes)
- A complete commercial description
- Relevance-ranked keywords (strongest first, no hallucinated terms)
- Primary and secondary categories

CRITICAL: Do NOT invent objects, environments, brands, or concepts not visible in the image. Do NOT use the filename as evidence."""

    request_payload = {
        'model': requested_model or GEMINI_MODEL,
        'contents': {
            'parts': [
                {'inline_data': {'mime_type': mime_type, 'data': image}},
                {'text': user_prompt},
            ],
        },
        'config': {
            'system_instruction': system_instruction,
            **GENAI_SCHEMA,
        },
    }

    try:
        response = generate_content_with_retry(client, request_payload)
        text_output = response.text
        if not text_output:
            raise Exception('AI returned empty response.')

        parsed = json.loads(text_output)

        # Post-process: normalize, validate
        processed, is_valid, issues = _post_process_metadata(parsed)

        if not is_valid:
            logger.warning(f'[AI Vision] Metadata validation issues for {file_name}: {issues}')

        set_cached_analysis(cache_key, processed)
        return JsonResponse(processed)

    except json.JSONDecodeError as e:
        logger.error(f'[AI Vision] Invalid JSON response: {e}')
        return JsonResponse({
            'error': 'AI returned invalid response format.',
            'technicalDetails': str(e),
            'canRetry': True,
        }, status=500)
    except Exception as e:
        logger.error(f'[AI Vision Analysis Error]: {e}')
        classified = classify_ai_error(e)
        return JsonResponse(classified, status=classified['statusCode'])


@csrf_exempt
async def image_to_prompt(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Invalid request method'}, status=405)

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    image = body.get('image')
    if not image:
        return JsonResponse({'error': 'Image base64 data is required.'}, status=400)

    mime_type = body.get('mimeType', 'image/png')
    file_name = body.get('fileName', 'artwork')

    try:
        client = get_gemini_client()
    except ValueError as e:
        return JsonResponse({'error': str(e)}, status=500)

    system_instruction = """You are an elite AI Prompt Reverse-Engineer and Prompt Engineer for generative image models (Midjourney v6, Stable Diffusion XL, Flux.1, DALL-E 3).
Analyze the visual input deeply to reconstruct the most accurate, detailed, and high-fidelity text prompt that could recreate this artwork from scratch."""

    prompt_text = f'Reverse-engineer this artwork (Filename: {file_name}) into a comprehensive AI image generation prompt and technical parameters.'

    request_payload = {
        'model': GEMINI_MODEL,
        'contents': {
            'parts': [
                {'inline_data': {'mime_type': mime_type, 'data': image}},
                {'text': prompt_text},
            ],
        },
        'config': {
            'system_instruction': system_instruction,
            **PROMPT_SCHEMA,
        },
    }

    try:
        response = generate_content_with_retry(client, request_payload)
        text_output = response.text
        if not text_output:
            raise Exception('AI returned empty response.')

        parsed = json.loads(text_output)
        return JsonResponse(parsed)

    except Exception as e:
        logger.error(f'Prompt generation error: {e}')
        classified = classify_ai_error(e)
        return JsonResponse(classified, status=classified['statusCode'])


@csrf_exempt
async def render_eps(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Invalid request method'}, status=405)

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    file_data = body.get('fileData')
    file_name = body.get('fileName', 'artwork.eps')

    if not file_data:
        return JsonResponse({'error': 'EPS file data (base64) is required.'}, status=400)

    try:
        result = render_eps_to_png(file_data, file_name)
        return JsonResponse({'success': True, **result})
    except Exception as e:
        logger.error(f'[EPS Render Error]: {e}')
        return JsonResponse({
            'error': 'Unable to render EPS preview. Please retry.',
            'canRetry': True,
            'details': str(e),
        }, status=422)


@csrf_exempt
def check_models(request):
    if request.method != 'GET':
        return JsonResponse({'error': 'Invalid request method'}, status=405)

    from .gemini_client import GEMINI_MODELS
    import time

    results = []
    try:
        client = get_gemini_client()
    except ValueError as e:
        return JsonResponse({'error': str(e)}, status=500)

    for model_name in GEMINI_MODELS:
        start = time.time()
        try:
            response = client.models.generate_content(
                model=model_name,
                contents='Reply with exactly: OK',
            )
            elapsed_ms = round((time.time() - start) * 1000)
            results.append({
                'id': model_name,
                'name': model_name.replace('gemini-', 'Gemini ').title(),
                'available': True,
                'latency_ms': elapsed_ms,
            })
        except Exception as e:
            elapsed_ms = round((time.time() - start) * 1000)
            message = str(e)
            status_code = 500
            if '503' in message or 'UNAVAILABLE' in message or 'high demand' in message:
                status_code = 503
            elif '404' in message or 'NOT_FOUND' in message:
                status_code = 404
            results.append({
                'id': model_name,
                'name': model_name.replace('gemini-', 'Gemini ').title(),
                'available': False,
                'status': status_code,
                'latency_ms': elapsed_ms,
            })

    return JsonResponse({'models': results})
