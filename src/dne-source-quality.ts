/** Indicates that source validation rejected rows or produced no usable CEP records. */
export class DneSourceQualityError extends Error {
  /**
   * Creates a source-quality failure that aborts the current load transaction.
   * @param message - Validation summary, including rejection counts or reasons when available.
   */
  constructor(message: string) {
    super(message);
    this.name = 'DneSourceQualityError';
  }
}

/** Row counts for a source file, import stage, or complete load. */
export type LoadQualityCounts = {
  /** Source rows examined. */
  read: number;
  /** Source rows accepted after validation. */
  accepted: number;
  /** Source rows rejected by validation. */
  rejected: number;
};

/** Validation counts augmented with machine-readable rejection reasons. */
export type LoadQualityBreakdown = LoadQualityCounts & {
  /** Rejected-row counts grouped by reason identifier. */
  rejection_reasons: Record<string, number>;
};

/** Aggregate validation results for a logical DNE source table. */
export type LoadQualityStage = LoadQualityBreakdown & {
  /** Per-file validation results keyed by the source filename. */
  files: Record<string, LoadQualityBreakdown>;
};

/** Quality report persisted only after a load has passed validation. */
export type LoadQualityReport = {
  /** Revision of the quality-report structure, independent of the database schema version. */
  version: 1;
  /** Successful validation marker; failed loads do not persist a report. */
  status: 'passed';
  /** Number of CEP rows written to the unified output. */
  output_rows: number;
  /** Total source-row counts across every stage. */
  totals: LoadQualityCounts;
  /** Validation results keyed by logical DNE source table name. */
  stages: Record<string, LoadQualityStage>;
};

type MutableQualityBreakdown = {
  read: number;
  accepted: number;
  rejected: number;
  rejectionReasons: Map<string, number>;
};

type MutableQualityStage = MutableQualityBreakdown & {
  files: Map<string, MutableQualityBreakdown>;
};

export type LoadQualityCounter = {
  read(): void;
  accept(): void;
  reject(reason: string): void;
};

/** Tracks validation counts per source table and file during an import. */
export class LoadQualityTracker {
  private stages: Map<string, MutableQualityStage>;

  constructor() {
    this.stages = new Map();
  }

  counter(stageName: string, fileName: string): LoadQualityCounter {
    const stage = this.stage(stageName);
    const file = this.file(stageName, fileName);
    return {
      read() {
        stage.read++;
        file.read++;
      },
      accept() {
        stage.accepted++;
        file.accepted++;
      },
      reject(reason: string) {
        stage.rejected++;
        file.rejected++;
        incrementReason(stage.rejectionReasons, reason);
        incrementReason(file.rejectionReasons, reason);
      },
    };
  }

  assertValid() {
    const rejected = Array.from(this.stages.values()).reduce((total, stage) => total + stage.rejected, 0);
    if (!rejected) {
      return;
    }

    const reasons = new Map<string, number>();
    for (const stage of this.stages.values()) {
      for (const [reason, count,] of stage.rejectionReasons) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + count);
      }
    }
    const summary = Array.from(reasons).map(([reason, count,]) => `${reason}=${count}`).join(', ');
    throw new DneSourceQualityError(`DNE source quality validation failed: ${rejected} rejected row(s) (${summary})`);
  }

  report(outputRows: number): LoadQualityReport {
    const totals: LoadQualityCounts = { read: 0, accepted: 0, rejected: 0 };
    const stages: Record<string, LoadQualityStage> = {};

    for (const [name, stage,] of this.stages) {
      totals.read += stage.read;
      totals.accepted += stage.accepted;
      totals.rejected += stage.rejected;
      const files: Record<string, LoadQualityBreakdown> = {};
      for (const [file, counts,] of stage.files) {
        files[file] = qualityBreakdown(counts);
      }
      stages[name] = { ...qualityBreakdown(stage), files };
    }

    return {
      version: 1,
      status: 'passed',
      output_rows: outputRows,
      totals,
      stages,
    };
  }

  private stage(name: string): MutableQualityStage {
    let stage = this.stages.get(name);
    if (!stage) {
      stage = { ...newQualityBreakdown(), files: new Map() };
      this.stages.set(name, stage);
    }
    return stage;
  }

  private file(stageName: string, fileName: string): MutableQualityBreakdown {
    const stage = this.stage(stageName);
    let file = stage.files.get(fileName);
    if (!file) {
      file = newQualityBreakdown();
      stage.files.set(fileName, file);
    }
    return file;
  }
}

function newQualityBreakdown(): MutableQualityBreakdown {
  return {
    read: 0,
    accepted: 0,
    rejected: 0,
    rejectionReasons: new Map(),
  };
}

function incrementReason(reasons: Map<string, number>, reason: string) {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

function qualityBreakdown(counts: MutableQualityBreakdown): LoadQualityBreakdown {
  return {
    read: counts.read,
    accepted: counts.accepted,
    rejected: counts.rejected,
    rejection_reasons: Object.fromEntries(counts.rejectionReasons),
  };
}
