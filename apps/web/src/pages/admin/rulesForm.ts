export type RulesForm = {
  allowedExtensions: string;
  submitFileCount: string;
  fileFormNames: string[];
  llmEnabled: boolean;
  llmPrompt: string;
};

export const emptyRules: RulesForm = {
  allowedExtensions: "pdf,hwpx",
  submitFileCount: "5",
  fileFormNames: Array.from({ length: 5 }, () => ""),
  llmEnabled: false,
  llmPrompt: "",
};

export function rulesFromJson(rulesJson: unknown): RulesForm {
  const r = (rulesJson ?? {}) as {
    fileRules?: { allowedExtensions?: string[]; maxFiles?: number; fileFormNames?: string[] };
    llm?: { enabled?: boolean; prompt?: string };
  };
  const exts = r.fileRules?.allowedExtensions?.length
    ? r.fileRules.allowedExtensions.join(", ")
    : emptyRules.allowedExtensions;
  const count =
    r.fileRules?.maxFiles != null ? String(r.fileRules.maxFiles) : emptyRules.submitFileCount;
  const countN = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : 0;

  const names = Array.isArray(r.fileRules?.fileFormNames)
    ? r.fileRules!.fileFormNames.map((x) => String(x ?? ""))
    : [];
  const normalizedNames =
    countN > 0 ? Array.from({ length: countN }, (_, i) => names[i] ?? "") : emptyRules.fileFormNames;
  return {
    allowedExtensions: exts,
    submitFileCount: count,
    fileFormNames: normalizedNames,
    llmEnabled: r.llm?.enabled ?? false,
    llmPrompt: r.llm?.prompt ?? "",
  };
}

export function rulesJsonFromForm(rules: RulesForm) {
  const exts = rules.allowedExtensions
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  const maxFiles = rules.submitFileCount.trim() ? Number(rules.submitFileCount) : undefined;
  const names =
    Number.isFinite(maxFiles) && maxFiles != null ? rules.fileFormNames.slice(0, maxFiles).map((s) => s.trim()) : [];
  return {
    fileRules: {
      allowedExtensions: exts.length ? exts : undefined,
      maxFiles: Number.isFinite(maxFiles) ? maxFiles : undefined,
      fileFormNames: Number.isFinite(maxFiles) ? names : undefined,
    },
    llm: {
      enabled: rules.llmEnabled,
      prompt: rules.llmPrompt.trim() || undefined,
    },
  };
}
