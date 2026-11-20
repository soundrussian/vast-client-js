import { Fetcher } from '../fetcher/fetcher';
import { parserUtils } from './parser_utils';
import { VASTParser } from './vast_parser';

export class PrefetchingVASTParser extends VASTParser {
  initParsingStatus(options) {
    this.prefetch = null;
    this.remainingAds = [];
    super.initParsingStatus(options);
  }

  resolveRootStandaloneAds(ads, options) {
    if (!this.remainingAds.some((ad) => ad.nextWrapperURL)) {
      return super.resolveRootStandaloneAds(ads, options);
    }

    const queue = createPrefetchQueue(this, options);
    this.prefetch = queue;
    const first = super.resolveRootStandaloneAds(ads, options);
    queue.prepareStandby();
    return first;
  }

  getRemainingAds(all) {
    if (!this.prefetch || this.remainingAds.length === 0) {
      return super.getRemainingAds(all);
    }

    return this.prefetch.consume(all);
  }
}

function createPrefetchQueue(parser, options) {
  const remaining = parser.remainingAds;
  const entries = new Map(
    remaining.map((ad, index) => [
      ad,
      { wrapperChainId: options.wrapperChainId + index + 1 },
    ])
  );
  const fetcher = new Fetcher();
  fetcher.urlHandler = parser.fetcher.urlHandler;
  fetcher.fetchingOptions = { ...parser.fetcher.fetchingOptions };
  fetcher.URLTemplateFilters = [...parser.fetcher.URLTemplateFilters];

  const rootErrorURLTemplates = [...parser.rootErrorURLTemplates];
  const vastVersion = parser.vastVersion;
  const maxWrapperDepth = parser.maxWrapperDepth;
  const keepFailedAdPod = parser.keepFailedAdPod;
  const parsingOptions = { ...parser.parsingOptions };
  const queue = { prepareStandby, consume };
  return queue;

  function start(ad) {
    const entry = entries.get(ad);
    if (entry.promise) {
      return entry.promise;
    }

    const worker = new VASTParser({ fetcher });
    // Speculative branches collect their own templates and defer tracking until consumed.
    worker.rootErrorURLTemplates = rootErrorURLTemplates;
    worker.vastVersion = vastVersion;
    worker.maxWrapperDepth = maxWrapperDepth;
    worker.parsingOptions = parsingOptions;
    const errors = [];
    worker.trackVastError = (...args) => errors.push(args);
    worker.on('*', (event, ...args) => {
      if (parser.prefetch === queue) {
        parser.emit(event, ...args);
      }
    });

    entry.promise = Promise.resolve()
      .then(() => worker.resolveAds([ad], {
        ...options,
        wrapperChainId: entry.wrapperChainId,
      }))
      .then(
        (ads) => ({ ads, errors, templates: worker.errorURLTemplates }),
        (error) => ({ rejected: true, error })
      )
      .then((result) => {
        entry.unusable =
          result.rejected ||
          !result.ads.some((candidate) => !parserUtils.isFailedAd(candidate));
        if (entry.unusable) {
          prepareStandby();
        }
        return result;
      });

    return entry.promise;
  }

  function prepareStandby() {
    if (parser.prefetch !== queue) {
      return;
    }
    const next = remaining.find((ad) => !entries.get(ad).unusable);
    if (next) {
      start(next);
    }
  }

  async function consume(all) {
    const ads = all ? remaining.splice(0) : [remaining.shift()];
    const results = ads.map((ad) => {
      const result = start(ad);
      entries.delete(ad);
      return result;
    });
    prepareStandby();
    const batch = await Promise.all(results);
    const failed = batch.find((result) => result.rejected);
    if (failed) {
      throw failed.error;
    }

    const finalizer = new VASTParser();
    finalizer.vastVersion = vastVersion;
    finalizer.keepFailedAdPod = keepFailedAdPod;
    finalizer.rootErrorURLTemplates = rootErrorURLTemplates;
    finalizer.errorURLTemplates = [].concat(...batch.map((result) => result.templates));
    finalizer.trackVastError = (...args) => {
      if (parser.prefetch === queue) {
        parser.trackVastError(...args);
      }
    };
    if (parser.prefetch === queue) {
      parser.errorURLTemplates = finalizer.errorURLTemplates;
    }
    for (const result of batch) {
      for (const error of result.errors) {
        finalizer.trackVastError(...error);
      }
    }
    return finalizer.buildVASTResponse([].concat(...batch.map((result) => result.ads)));
  }
}
