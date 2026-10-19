import logging
import os
import re

log = logging.getLogger(__name__)


def set_security_headers() -> dict[str, str]:
    """
    Sets security headers based on environment variables.

    This function reads specific environment variables and uses their values
    to set corresponding security headers. The headers that can be set are:
    - cache-control
    - permissions-policy
    - strict-transport-security
    - referrer-policy
    - x-content-type-options
    - x-download-options
    - x-frame-options
    - x-permitted-cross-domain-policies
    - content-security-policy
    - content-security-policy-report-only
    - cross-origin-embedder-policy
    - cross-origin-opener-policy
    - cross-origin-resource-policy
    - reporting-endpoints

    Each environment variable is associated with a specific setter function
    that constructs the header. If the environment variable is set, the
    corresponding header is added to the options dictionary.

    Returns:
        dict: A dictionary containing the security headers and their values.
    """
    options = {}
    header_setters = {
        'CACHE_CONTROL': set_cache_control,
        'HSTS': set_hsts,
        'PERMISSIONS_POLICY': set_permissions_policy,
        'REFERRER_POLICY': set_referrer,
        'XCONTENT_TYPE': set_xcontent_type,
        'XDOWNLOAD_OPTIONS': set_xdownload_options,
        'XFRAME_OPTIONS': set_xframe,
        'XPERMITTED_CROSS_DOMAIN_POLICIES': set_xpermitted_cross_domain_policies,
        'CONTENT_SECURITY_POLICY': set_content_security_policy,
        'CONTENT_SECURITY_POLICY_REPORT_ONLY': set_content_security_policy_report_only,
        'CROSS_ORIGIN_EMBEDDER_POLICY': set_cross_origin_embedder_policy,
        'CROSS_ORIGIN_OPENER_POLICY': set_cross_origin_opener_policy,
        'CROSS_ORIGIN_RESOURCE_POLICY': set_cross_origin_resource_policy,
        'REPORTING_ENDPOINTS': set_reporting_endpoints,
    }

    for env_var, setter in header_setters.items():
        value = os.environ.get(env_var, None)
        if value:
            header = setter(value)
            if header:
                options.update(header)

    return options


# Set HTTP Strict Transport Security(HSTS) response header
HSTS_FALLBACK = 'max-age=31536000; includeSubDomains'


def set_hsts(value: str):
    # Directives may be separated by whitespace after the semicolon, which is
    # how they are usually written (`max-age=63072000; includeSubDomains;
    # preload`). Rejecting that spelling silently replaced a stronger policy
    # with the fallback.
    pattern = r'^\s*max-age=(\d+)(\s*;\s*includeSubDomains)?(\s*;\s*preload)?\s*;?\s*$'
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        log.warning('HSTS=%r is not a valid Strict-Transport-Security value; sending %r instead', value, HSTS_FALLBACK)
        value = HSTS_FALLBACK
    return {'Strict-Transport-Security': value.strip()}


# Set X-Frame-Options response header
def set_xframe(value: str):
    pattern = r'^(DENY|SAMEORIGIN)$'
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        value = 'DENY'
    return {'X-Frame-Options': value}


# Set Permissions-Policy response header
#
# One directive: a feature name, then `*` or an allowlist in parentheses of
# `self`, `src`, `*` or quoted origins (RFC 8941 structured-field syntax as the
# spec uses it): `camera=(), geolocation=(self "https://maps.example")`.
_PERMISSIONS_DIRECTIVE = re.compile(
    r'^\s*[a-z][a-z0-9-]*\s*=\s*(\*|\(\s*((self|src|\*|"[^"\s]+")\s*)*\))\s*$', re.IGNORECASE
)


def set_permissions_policy(value: str):
    directives = value.split(',')
    if not value.strip() or not all(_PERMISSIONS_DIRECTIVE.match(d) for d in directives):
        # No fallback: the old one, `none`, is not valid syntax, so browsers
        # ignored the header while the configuration looked applied.
        log.warning('PERMISSIONS_POLICY=%r is not a valid Permissions-Policy value; the header is not sent', value)
        return {}
    return {'Permissions-Policy': ', '.join(d.strip() for d in directives)}


# Set Referrer-Policy response header
def set_referrer(value: str):
    pattern = (
        r'^(no-referrer|no-referrer-when-downgrade|origin|origin-when-cross-origin|same-origin|strict-origin|'
        r'strict-origin-when-cross-origin|unsafe-url)$'
    )
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        value = 'no-referrer'
    return {'Referrer-Policy': value}


# Set Cache-Control response header
def set_cache_control(value: str):
    pattern = (
        r'^(public|private|no-cache|no-store|must-revalidate|proxy-revalidate|max-age=\d+|s-maxage=\d+|no-transform|immutable)'
        r'(,\s*(public|private|no-cache|no-store|must-revalidate|proxy-revalidate|max-age=\d+|s-maxage=\d+|no-transform|'
        r'immutable))*$'
    )
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        value = 'no-store, max-age=0'

    return {'Cache-Control': value}


# Set X-Download-Options response header
def set_xdownload_options(value: str):
    if value != 'noopen':
        value = 'noopen'
    return {'X-Download-Options': value}


# Set X-Content-Type-Options response header
def set_xcontent_type(value: str):
    if value != 'nosniff':
        value = 'nosniff'
    return {'X-Content-Type-Options': value}


# Set X-Permitted-Cross-Domain-Policies response header
def set_xpermitted_cross_domain_policies(value: str):
    pattern = r'^(none|master-only|by-content-type|by-ftp-filename)$'
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        value = 'none'
    return {'X-Permitted-Cross-Domain-Policies': value}


# Set Content-Security-Policy response header
def set_content_security_policy(value: str):
    return {'Content-Security-Policy': value}


# Set Content-Security-Policy-Report-Only response header
def set_content_security_policy_report_only(value: str):
    return {'Content-Security-Policy-Report-Only': value}


# Set Cross-Origin-Embedder-Policy response header
def set_cross_origin_embedder_policy(value: str):
    pattern = r'^(unsafe-none|require-corp|credentialless)$'
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        value = 'require-corp'
    return {'Cross-Origin-Embedder-Policy': value}


# Set Cross-Origin-Opener-Policy response header
def set_cross_origin_opener_policy(value: str):
    pattern = r'^(unsafe-none|same-origin-allow-popups|same-origin)$'
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        value = 'same-origin'
    return {'Cross-Origin-Opener-Policy': value}


# Set Cross-Origin-Resource-Policy response header
def set_cross_origin_resource_policy(value: str):
    pattern = r'^(same-site|same-origin|cross-origin)$'
    match = re.match(pattern, value, re.IGNORECASE)
    if not match:
        value = 'same-origin'
    return {'Cross-Origin-Resource-Policy': value}


# Set Reporting-Endpoints response header
def set_reporting_endpoints(value: str):
    return {'Reporting-Endpoints': value}
