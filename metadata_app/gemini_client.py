import os
import time
import hashlib
import logging

logger = logging.getLogger(__name__)

GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash']
GEMINI_MODEL = GEMINI_MODELS[0]
BACKOFF_DELAYS = [2000, 4000]

_visual_analysis_cache = {}


def get_gemini_client():
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        raise ValueError('GEMINI_API_KEY environment variable is not configured.')
    try:
        from google import genai
        client = genai.Client(
            api_key=api_key,
            http_options={'headers': {'User-Agent': 'aistudio-build'}},
        )
        return client
    except ImportError:
        raise ValueError('google-genai package is not installed. Run: pip install google-genai')


def classify_ai_error(err):
    message = str(err)
    if any(kw in message for kw in ('429', 'RESOURCE_EXHAUSTED', 'quota', 'Rate limit', 'rate-limit', 'exhausted')):
        return {
            'statusCode': 429,
            'errorCode': '429 / RESOURCE_EXHAUSTED',
            'error': 'API quota or rate limit exceeded. Please wait a moment or retry.',
            'technicalDetails': message,
            'canRetry': True,
        }
    if any(kw in message for kw in ('503', 'UNAVAILABLE', 'overloaded', 'high demand')):
        return {
            'statusCode': 503,
            'errorCode': '503 / SERVICE_UNAVAILABLE',
            'error': 'Gemini service is temporarily unavailable or overloaded.',
            'technicalDetails': message,
            'canRetry': True,
        }
    if any(kw in message for kw in ('504', 'TIMEOUT', 'timed out', 'DEADLINE_EXCEEDED')):
        return {
            'statusCode': 504,
            'errorCode': '504 / TIMEOUT',
            'error': 'AI vision analysis timed out.',
            'technicalDetails': message,
            'canRetry': True,
        }
    return {
        'statusCode': 500,
        'errorCode': '500 / AI_ANALYSIS_FAILED',
        'error': 'AI vision analysis failed. Please retry.',
        'technicalDetails': message,
        'canRetry': True,
    }


def generate_content_with_retry(client, request_payload, max_retries=2):
    models_to_try = list(GEMINI_MODELS)
    attempt = 0
    last_error = None

    for model_idx, model_name in enumerate(models_to_try):
        payload = {**request_payload, 'model': model_name}
        attempt = 0
        while attempt <= max_retries:
            try:
                logger.info(f'[AI Vision] Trying model: {model_name} (attempt {attempt + 1})')
                return client.models.generate_content(**payload)
            except Exception as err:
                last_error = err
                attempt += 1
                message = str(err)
                is_overloaded = any(kw in message for kw in ('503', 'UNAVAILABLE', 'overloaded', 'high demand'))
                if is_overloaded and model_idx < len(models_to_try) - 1:
                    logger.warning(f'[AI Vision] Model {model_name} overloaded, switching to next model...')
                    break
                if attempt > max_retries:
                    break
                delay_ms = BACKOFF_DELAYS[attempt - 1] if attempt - 1 < len(BACKOFF_DELAYS) else 5000
                logger.warning(f'[AI Vision] Request failed (attempt {attempt}/{max_retries}). Retrying in {delay_ms}ms... {err}')
                time.sleep(delay_ms / 1000)
    raise last_error or Exception('AI processing failed after all retries and model fallbacks.')


def get_cached_analysis(file_hash, image_data):
    cache_key = file_hash or hashlib.sha256(image_data[:10000].encode('utf-8')).hexdigest()
    return _visual_analysis_cache.get(cache_key), cache_key


def set_cached_analysis(cache_key, data):
    _visual_analysis_cache[cache_key] = data
