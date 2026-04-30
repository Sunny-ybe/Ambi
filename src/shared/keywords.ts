const STOPWORDS = new Set([
  "a","about","above","after","again","against","all","am","an","and","any",
  "are","aren't","as","at","be","because","been","before","being","below",
  "between","both","but","by","can't","cannot","could","couldn't","did",
  "didn't","do","does","doesn't","doing","don't","down","during","each",
  "few","for","from","further","get","got","had","hadn't","has","hasn't",
  "have","haven't","having","he","he'd","he'll","he's","her","here","here's",
  "hers","herself","him","himself","his","how","how's","i","i'd","i'll","i'm",
  "i've","if","in","into","is","isn't","it","it's","its","itself","let's",
  "me","more","most","mustn't","my","myself","no","nor","not","of","off",
  "on","once","only","or","other","ought","our","ours","ourselves","out",
  "over","own","same","shan't","she","she'd","she'll","she's","should",
  "shouldn't","so","some","such","than","that","that's","the","their",
  "theirs","them","themselves","then","there","there's","these","they",
  "they'd","they'll","they're","they've","this","those","through","to","too",
  "under","until","up","very","was","wasn't","we","we'd","we'll","we're",
  "we've","were","weren't","what","what's","when","when's","where","where's",
  "which","while","who","who's","whom","why","why's","will","with","won't",
  "would","wouldn't","you","you'd","you'll","you're","you've","your","yours",
  "yourself","yourselves","just","like","use","using","used","also","can",
  "may","might","shall","now","make","made","want","need","help","work",
  "working","please","thanks","okay","yes","no","new","old","one","two",
  "first","last","next","good","well","back","still","way","even","much",
  "many","see","know","think","look","come","go","take","give","find"
]);

/**
 * Extract meaningful keywords from a string.
 * Returns lowercase tokens, deduped, stopwords removed, min 3 chars.
 */
export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

  return [...new Set(tokens)];
}

/**
 * Score how many keywords from `query` appear in `targets`.
 */
export function keywordOverlap(queryKeywords: string[], targets: string[]): number {
  const targetSet = new Set(targets);
  return queryKeywords.filter((k) => targetSet.has(k)).length;
}
