/**
 * The full source of truth for the SDK v3 static-translations keys.
 *
 * **Location**: NOT in `./locales/` — otherwise the Rollup glob `./locales/${key}.ts`
 * would bake it into a separate chunk that never loads at runtime (EN is the
 * inline fallback) and wastes ~6KB of build size for nothing.
 *
 * **Runtime**: this file is NOT loaded in the browser — the EN fallbacks are always
 * inline in the `t('auth.welcome', 'Welcome back!')` calls inside the blocks. Keeping
 * the inline strings in sync with the values here is the block author's responsibility.
 *
 * **Tests**: tests can import this dictionary and verify that blocks use known
 * keys (to avoid typos in production).
 */
const en = {
  // === navigation ===
  'nav.back': '← Back',
  'nav.back_aria': 'Back',

  // === modal / paywall root ===
  'modal.loading': 'Loading…',
  'modal.verifying_subscription': 'Checking your subscription…',
  'modal.error_generic': 'Something went wrong',
  'modal.continue': 'Continue',
  'modal.purchase_success_title': 'Payment received',
  'modal.purchase_success_subtitle': "You're all set — enjoy!",
  'modal.purchase_restored_title': 'Welcome back',
  'modal.purchase_restored_subtitle': "You're all set — enjoy!",
  'modal.close_aria': 'Close',

  // === payment awaiting / popup blocked ===
  'payment.awaiting_title': 'Complete payment in the new tab',
  'payment.awaiting_subtitle':
    "We'll detect your payment automatically — or click below once you're done.",
  'payment.checking': 'Checking…',
  'payment.ive_paid': "I've paid",
  'payment.still_processing': 'Payment is still being processed. Please try again in a moment.',
  'payment.popup_help_text': "Checkout window didn't open or got blocked? Click here to open it again.",
  'payment.open_checkout_again': 'Open checkout again',
  'payment.tab_closed_retry': 'Tab closed? Try again',
  'payment.popup_blocked_title': 'Allow popups to continue',
  'payment.popup_blocked_message': 'Your browser blocked the checkout tab. Click below to open it.',
  'payment.open_checkout_button': 'Open checkout',

  // === auth / oauth ===
  'auth.continue_with_google': 'Continue with Google',
  'auth.continue_with_apple': 'Continue with Apple',
  'auth.continue_with_github': 'Continue with GitHub',
  'auth.continue_with_facebook': 'Continue with Facebook',
  'auth.or': 'or',

  // === auth / form fields ===
  'auth.email': 'Email address',
  'auth.password': 'Password',
  'auth.repeat_password': 'Repeat password',
  'auth.confirmation_code': 'Confirmation code',
  'auth.new_password_optional': 'New password (optional — only for password reset)',

  // === auth / buttons + links ===
  'auth.log_in': 'Sign In',
  'auth.sign_up': 'Sign Up',
  'auth.create_account': 'Create Account',
  'auth.send_reset': 'Send Reset Email',
  'auth.verify': 'Verify',
  'auth.forgot_password': 'Forgot password?',
  'auth.no_account': "Don't have an account?",
  'auth.have_account': 'Already have an account?',
  'auth.sign_up_link': 'Sign Up',
  'auth.log_in_link': 'Log In',
  'auth.show_password': 'Show password',
  'auth.hide_password': 'Hide password',
  'auth.last_used': 'Last · {email}',

  // === auth / heading + subtitle ===
  'auth.welcome': 'Welcome back!',
  'auth.welcome_signup': 'Welcome!',
  'auth.default_subtitle': 'Sign in to access all features and sync your data.',
  'auth.forgot_password_title': 'Forgot password?',
  'auth.forgot_subtitle': "Enter your email and we'll send you a password reset link.",
  'auth.check_email_title': 'Check your email',
  'auth.reset_password_title': 'Reset password',
  'auth.reset_password_subtitle': 'Enter the code from your email and a new password.',
  'auth.confirm_email_title': 'Confirm your email',
  'auth.confirm_email_subtitle': 'Enter the code we sent to your email to finish creating your account.',

  // === auth / messages + errors ===
  'auth.passwords_mismatch': "Passwords don't match",
  'auth.check_email_message': 'Check your email for a confirmation code.',
  'auth.reset_sent_message': 'If that email exists, a reset code has been sent.',
  'auth.reset_sent_subtitle': 'We sent a password reset link. Follow the instructions in the email to reset your password.',
  'auth.signup_sent_subtitle': 'We sent a confirmation link to your email. Click it to activate your account, then sign in.',
  'auth.reset_link_valid': 'The link is valid for 1 hour.',
  'auth.back_to_login': 'Back to Login',
  'auth.signin_failed': 'Sign-in failed',
  'auth.signup_failed': 'Sign-up failed',
  'auth.generic_error': 'Something went wrong',
  'auth.invalid_credentials': 'Invalid email or password',
  'auth.email_not_confirmed': 'Please confirm your email before signing in.',
  'auth.email_exists': 'An account with this email already exists.',
  'auth.weak_password': 'Password is too weak.',
  'auth.invalid_otp': 'The code is invalid or has expired.',
  'auth.rate_limited': 'Too many requests. Please try again later.',
  'auth.network_error': 'Network error. Please check your connection and try again.',
  'auth.service_unavailable': 'Service is temporarily unavailable. Please try again.',

  // === auth gate (intent-specific) ===
  'auth.restore_purchases_heading': 'Restore Purchases',
  'auth.restore_purchases_subheading': 'Please sign in to restore your purchases.',
  'auth.login_continue_purchase': 'Log in to continue your purchase',
  'auth.link_purchase_subheading': "We'll link the purchase to your account to keep access.",

  // === auth panel signed-in indicator ===
  'auth.signed_in': 'Signed in',
  'auth.sign_out': 'Sign out',

  // === current session block ===
  // Prefix-only — the email is rendered as a separate <b> element on the right,
  // to preserve the bold layout. Languages with reversed order ("by X is signed
  // in") must rewrite the key entirely and move the email in the code.
  'session.signed_in_as_prefix': 'Signed in as',
  'session.signing_out': 'Signing out…',
  'session.sign_out': 'Sign Out',
  'session.restore_purchases': 'Restore purchases',
  'session.contact_support': 'Contact Support',

  // === anon gate ===
  'anon.heading_default': 'Continue as guest',
  'anon.description_default': 'Setting up your guest session…',
  'anon.try_again': 'Try again',

  // === cta button ===
  'cta.close': 'Close',
  'cta.continue': 'Continue',
  'cta.start_trial': 'Start {days}-Day Free Trial',
  'cta.get_lifetime_access': 'Get Lifetime Access',
  'cta.get_plan_daily': 'Get Daily Plan',
  'cta.get_plan_weekly': 'Get Weekly Plan',
  'cta.get_plan_monthly': 'Get Monthly Plan',
  'cta.get_plan_yearly': 'Get Yearly Plan',
  'cta.get_plan_generic': 'Get {interval} Plan',

  // === pricing / price grid ===
  'pricing.no_prices': 'No prices available.',
  'pricing.plans_aria': 'Plans',
  'pricing.most_popular': 'Most popular',
  'pricing.plan_label.daily': 'DAILY PLAN',
  'pricing.plan_label.weekly': 'WEEKLY PLAN',
  'pricing.plan_label.monthly': 'MONTHLY PLAN',
  'pricing.plan_label.yearly': 'YEARLY PLAN',
  'pricing.plan_label.lifetime': 'LIFETIME',
  'pricing.free_trial_days': '{days}-day free trial',
  'pricing.money_back': '30-day money-back guarantee',

  // === pricing intervals (used by TokenizationGate "Included per X:") ===
  'pricing.interval.day': 'day',
  'pricing.interval.week': 'week',
  'pricing.interval.month': 'month',
  'pricing.interval.year': 'year',
  'pricing.interval.period': 'period',
  'pricing.included_per': 'Included per {interval}:',
  'pricing.included_total': 'Included for lifetime:',

  // === offer banner ===
  'offer.limited_time': 'Limited-time offer',
  'countdown.d': 'd',
  'countdown.h': 'h',
  'countdown.m': 'm',
  'countdown.s': 's',

  // === support gate ===
  'support.heading': 'Support',
  'support.instruction': 'Please fill out the form below to submit your support request.',
  'support.email_placeholder': 'Enter your email *',
  'support.sending_as': 'Sending as ',
  'support.subject_placeholder': 'Enter your subject *',
  'support.message_placeholder': 'Enter your message *',
  'support.send_button': 'Send',
  'support.sending': 'Sending…',
  'support.close_button': 'Close',
  'support.done_button': 'Done',
  'support.send_another': 'Send another request',
  'support.success_heading': 'Request submitted',
  // Prefix-only — the email is rendered as a separate <b> element on the right, with a period after.
  'support.success_message_prefix': "We've received your message and will respond to",
  'support.attachments_label': 'Attachments (optional)',
  'support.attachments_aria': 'Attachments upload',
  'support.dropzone_text': 'Drop images here or click to select',
  'support.file_requirements': 'JPEG/PNG/WebP, up to {max} files, ≤ 10MB each',
  'support.too_many_files': 'Up to {max} files',
  'support.invalid_file': 'Only JPEG/PNG/WebP, ≤ 10MB each',
  'support.remove_file_aria': 'Remove {filename}',
  'support.required': 'Required',
  'support.invalid_email': 'Invalid email',
  'support.subject_length': '{min}–{max} characters',
  'support.message_length': '{min}–{max} characters'
} as const;

export type TranslationKey = keyof typeof en;
export default en;
