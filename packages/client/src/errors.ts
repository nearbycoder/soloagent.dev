/**
 * What a provider error means and what to do about it, for the errors people hit most. Callers show this as a
 * headline and keep the raw message underneath, so nothing is hidden. Undefined when there's nothing to add.
 */
export function explainError(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/^429\b|rate.?limit|too many requests/.test(t)) return "The provider is rate-limiting requests. Wait a minute, then try again.";
  if (/^529\b|overloaded/.test(t)) return "The provider is overloaded right now. Try again in a moment.";
  if (/^40[13]\b|invalid.{0,12}(api.?key|token|credential)|unauthori[sz]ed|authentication/.test(t))
    return "The provider rejected the credentials. Sign in again or update the key under Providers.";
  if (/context.{0,20}(length|window)|too many tokens|prompt is too long|maximum context/.test(t))
    return "This conversation is too long for the model. Compact it or reset the context.";
  if (/quota|billing|insufficient.{0,10}(funds|credit|balance)|credit balance/.test(t)) return "The provider account is out of credit or quota.";
  if (/fetch failed|econnrefused|enotfound|etimedout|network/.test(t)) return "Couldn't reach the provider. Check the server's network connection.";
  return undefined;
}
