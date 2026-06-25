/**
 * 敏感信息清洗器
 * 一期覆盖最常见的 token/key 模式
 */
export class SecretSanitizer {
  private static patterns: Array<{ name: string; regex: RegExp; mask: string }> = [
    { name: 'GitHub Token', regex: /ghp_[a-zA-Z0-9]{36}/g, mask: '<REDACTED_GITHUB_TOKEN>' },
    { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{48}/g, mask: '<REDACTED_OPENAI_KEY>' },
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, mask: '<REDACTED_AWS_KEY>' },
    {
      name: 'Private Key Header',
      regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      mask: '<REDACTED_PRIVATE_KEY>',
    },
  ];

  sanitize(text: string): string {
    let result = text;
    for (const pattern of SecretSanitizer.patterns) {
      result = result.replace(pattern.regex, pattern.mask);
    }
    return result;
  }
}
