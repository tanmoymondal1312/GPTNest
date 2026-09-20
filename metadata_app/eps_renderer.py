import os
import hashlib
import struct
import subprocess
import tempfile
import base64

_eps_cache = {}


def clean_eps_buffer(raw_bytes):
    if len(raw_bytes) >= 30:
        if raw_bytes[0] == 0xC5 and raw_bytes[1] == 0xD0 and raw_bytes[2] == 0xD3 and raw_bytes[3] == 0xC6:
            ps_offset = struct.unpack_from('<I', raw_bytes, 4)[0]
            ps_length = struct.unpack_from('<I', raw_bytes, 8)[0]
            if ps_offset > 0 and ps_length > 0 and ps_offset + ps_length <= len(raw_bytes):
                return raw_bytes[ps_offset:ps_offset + ps_length]
    return raw_bytes


def parse_eps_bounding_box(raw_bytes):
    try:
        text_header = raw_bytes[:min(len(raw_bytes), 32768)].decode('latin1', errors='replace')
        import re
        bbox_match = (
            re.search(r'%%BoundingBox:\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)', text_header, re.IGNORECASE)
            or re.search(r'%%HiResBoundingBox:\s*([\d\.]+)\s+([\d\.]+)\s+([\d\.]+)\s+([\d\.]+)', text_header, re.IGNORECASE)
        )
        if bbox_match:
            x1, y1 = float(bbox_match.group(1)), float(bbox_match.group(2))
            x2, y2 = float(bbox_match.group(3)), float(bbox_match.group(4))
            w, h = abs(x2 - x1), abs(y2 - y1)
            if w > 10 and h > 10:
                max_dim_pt = max(w, h)
                target_px = 1800
                calculated_dpi = round((target_px / max_dim_pt) * 72)
                clamped_dpi = max(100, min(300, calculated_dpi))
                return {'width': round(w), 'height': round(h), 'dpi': clamped_dpi}
    except Exception:
        pass
    return {'width': 800, 'height': 600, 'dpi': 200}


def validate_png_buffer(buf):
    if not buf or len(buf) < 24:
        return {'valid': False, 'width': 0, 'height': 0, 'error': 'PNG buffer is too short or empty.'}
    is_png = (
        buf[0] == 0x89 and buf[1] == 0x50 and buf[2] == 0x4E and buf[3] == 0x47
        and buf[4] == 0x0D and buf[5] == 0x0A and buf[6] == 0x1A and buf[7] == 0x0A
    )
    if not is_png:
        return {'valid': False, 'width': 0, 'height': 0, 'error': 'Rendered file is not a valid PNG image.'}
    width = struct.unpack_from('>I', buf, 16)[0]
    height = struct.unpack_from('>I', buf, 20)[0]
    if width <= 0 or height <= 0:
        return {'valid': False, 'width': width, 'height': height, 'error': 'Rendered PNG has invalid dimensions.'}
    return {'valid': True, 'width': width, 'height': height}


def render_eps_to_png(base64_data, filename='artwork.eps'):
    clean_b64 = base64_data.split(',')[1] if ',' in base64_data else base64_data
    raw_bytes = base64.b64decode(clean_b64)

    if not raw_bytes or len(raw_bytes) == 0:
        raise ValueError('Uploaded EPS file is empty or corrupted.')

    file_hash = hashlib.sha256(raw_bytes).hexdigest()
    if file_hash in _eps_cache:
        return _eps_cache[file_hash]

    clean_buffer = clean_eps_buffer(raw_bytes)
    bbox = parse_eps_bounding_box(clean_buffer)
    dpi = bbox['dpi']

    tmp_dir = tempfile.gettempdir()
    file_id = f"eps_{os.getpid()}_{hashlib.md5(raw_bytes[:1024]).hexdigest()[:12]}"
    eps_path = os.path.join(tmp_dir, f"{file_id}.eps")
    png_path = os.path.join(tmp_dir, f"{file_id}.png")

    try:
        with open(eps_path, 'wb') as f:
            f.write(clean_buffer)

        render_success = False

        try:
            subprocess.run(
                [
                    'gs', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop',
                    '-sDEVICE=pngalpha', f'-r{dpi}',
                    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                    f'-sOutputFile={png_path}', eps_path,
                ],
                check=True, timeout=15,
                capture_output=True,
            )
            if os.path.exists(png_path):
                render_success = True
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass

        if not render_success:
            try:
                subprocess.run(
                    [
                        'convert', '-density', str(dpi), '-colorspace', 'sRGB',
                        eps_path, '-resize', '2000x2000>', png_path,
                    ],
                    check=True, timeout=15,
                    capture_output=True,
                )
                if os.path.exists(png_path):
                    render_success = True
            except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass

        if not render_success or not os.path.exists(png_path):
            raise ValueError('Unable to render EPS preview. Please retry.')

        with open(png_path, 'rb') as f:
            png_buffer = f.read()

        validation = validate_png_buffer(png_buffer)
        if not validation['valid']:
            raise ValueError(validation.get('error', 'Unable to render EPS preview.'))

        pixel_width = validation['width']
        pixel_height = validation['height']

        ratio = pixel_width / pixel_height if pixel_height > 0 else 1
        if abs(ratio - 1) < 0.08:
            orientation = 'Square'
        elif ratio < 0.92:
            orientation = 'Portrait'
        else:
            orientation = 'Landscape'

        b64_result = base64.b64encode(png_buffer).decode('utf-8')
        preview_url = f'data:image/png;base64,{b64_result}'

        result = {
            'previewUrl': preview_url,
            'base64Data': b64_result,
            'mimeType': 'image/png',
            'width': pixel_width,
            'height': pixel_height,
            'dimensions': f'{pixel_width} x {pixel_height} px (EPS Vector)',
            'orientation': orientation,
            'hasTransparency': True,
            'backgroundType': 'Transparent',
            'dominantColors': ['#38bdf8', '#818cf8'],
        }

        _eps_cache[file_hash] = result
        return result

    finally:
        for p in (eps_path, png_path):
            try:
                if os.path.exists(p):
                    os.unlink(p)
            except OSError:
                pass
