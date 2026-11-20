//eslint-disable-next-line
import { VASTClient, VASTTracker } from '@dailymotion/vast-client';

const mainContent =
  'https://dmplayer.storage.googleapis.com/tech_test/midnight_sun_720p.mp4';
const videoPlayer = document.getElementById('myVideo');
const variationImg = document.getElementById('variationImg');
const variationContainer = document.getElementById('variationContainer');

//vastTracker for linear ads
let vastTracker = null;
//vastTracker for companion ads
let companionVastTracker = null;

function selectMedia(ad) {
  for (const creative of ad.creatives) {
    if (creative.type !== 'linear') {
      continue;
    }
    const media = creative.mediaFiles.find(
      (file) => file.fileURL &&
        (!file.mimeType || videoPlayer.canPlayType(file.mimeType))
    );
    if (media) {
      return { creative, media };
    }
  }
  return null;
}

function startMedia(url) {
  return new Promise((resolve, reject) => {
    function finish(error) {
      videoPlayer.removeEventListener('playing', onPlaying);
      videoPlayer.removeEventListener('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function onPlaying() {
      finish();
    }

    function onError() {
      finish(videoPlayer.error || new Error('Ad media failed'));
    }

    videoPlayer.addEventListener('playing', onPlaying);
    videoPlayer.addEventListener('error', onError);
    videoPlayer.src = url;
    videoPlayer.play().catch(finish);
  });
}

export const playPreroll = async () => {
  const client = new VASTClient();
  const url = 'https://statics.dmcdn.net/h/html/vast/simple-inline.xml';
  videoPlayer.pause();
  let response;

  try {
    response = await client.get(url);
  } catch (error) {
    stopAd();
    return;
  }

  while (response) {
    for (const ad of response.ads) {
      if (ad.hasFailed) {
        continue;
      }
      const selection = selectMedia(ad);
      if (!selection) {
        client.getParser().trackVastError(ad.errorURLTemplates, { ERRORCODE: 403 });
        continue;
      }
      const { creative, media } = selection;
      const tracker = new VASTTracker(client, ad, creative);
      try {
        await startMedia(media.fileURL);
      } catch (error) {
        if (error.name === 'NotAllowedError') {
          stopAd();
          return;
        }
        tracker.error({ ERRORCODE: 405 });
        continue;
      }

      vastTracker = tracker;
      const companion = getCreativeCompanion(ad);
      const variationData = getVariationData(companion);
      if (variationData) {
        companionVastTracker = new VASTTracker(
          null,
          ad,
          companion,
          variationData.variation
        );
        displayVariation(variationData);
        companionVastTracker.track('creativeView');
      }

      initTrackers();
      tracker.trackImpression();
      return;
    }

    response = null;
    while (client.hasRemainingAds() && !response) {
      try {
        response = await client.getNextAds();
      } catch (error) {
        // A failed candidate was consumed. Continue from the next entry.
      }
    }
  }
  stopAd();
};

/**
 * Stop the ad and remove all EventListeners
 */

export const stopAd = () => {
  removeTrackers(videoPlayer);
  vastTracker = null;
  companionVastTracker = null;
  variationContainer.style.display = 'none';
  if (videoPlayer.src !== mainContent) {
    videoPlayer.src = mainContent;
  }
  videoPlayer.play().catch(() => {
    // Leave the video controls available when autoplay is blocked.
  });
};

/**
 *  attach all the EventListeners to the videoPlayer
 */
export const initTrackers = () => {
  videoPlayer.addEventListener('volumechange', handleMuteTrackers);
  videoPlayer.addEventListener('click', handleClickTrackers);
  videoPlayer.addEventListener('timeupdate', handleTimeUpdateTrackers);
  videoPlayer.addEventListener('ended', handleCompleteTrackers);
  videoPlayer.addEventListener('play', handleResumeTrackers);
  videoPlayer.addEventListener('pause', handlePauseTrackers);
  videoPlayer.addEventListener('error', handleErrorTrackers);
  //listener on the variation container to detect the click an fire the tracker
  variationImg.addEventListener('click', handleCompanionClickTrackers);
};

/**
 * removes all the EventListeners from the videoPlayer
 */
export const removeTrackers = () => {
  videoPlayer.removeEventListener('volumechange', handleMuteTrackers);
  videoPlayer.removeEventListener('click', handleClickTrackers);
  videoPlayer.removeEventListener('timeupdate', handleTimeUpdateTrackers);
  videoPlayer.removeEventListener('play', handleResumeTrackers);
  videoPlayer.removeEventListener('pause', handlePauseTrackers);
  videoPlayer.removeEventListener('ended', handleCompleteTrackers);
  videoPlayer.removeEventListener('error', handleErrorTrackers);
  variationImg.removeEventListener('click', handleCompanionClickTrackers);
};

/**
 * Send  mute and unmute trackers using the vastTracker
 */
const handleMuteTrackers = (e) => {
  if (!vastTracker) {
    return;
  }

  const muted = e.target.muted;
  vastTracker.setMuted(muted);
};

/**
 * Send click trackers using the vastTracker
 */
const handleClickTrackers = (e) => {
  if (!vastTracker) {
    return;
  }

  // The values for the CLICKPOS macros depends on your player implementations logic
  vastTracker.click(null, { CLICKPOS: [e.clientX, e.clientY] });
  vastTracker.on('clickthrough', (url) => {
    window.open(url, '_blank');
  });
};

/**
 * Send companion click trackers using the vastTracker
 */
const handleCompanionClickTrackers = () => {
  if (!companionVastTracker) {
    return;
  }
  companionVastTracker.click();
  companionVastTracker.on('clickthrough', (url) => {
    window.open(url, '_blank');
  });
};

/**
 * Send complete tracker using the vastTracker
 */
const handleCompleteTrackers = () => {
  if (!vastTracker) {
    return;
  }
  vastTracker.complete();
  stopAd();
};

/**
 * Send pause tracker using the vastTracker
 */

const handlePauseTrackers = () => {
  if (!vastTracker) {
    return;
  }
  vastTracker.setPaused(true);
};

/**
 * Send resume tracker using the vastTracker
 */
const handleResumeTrackers = () => {
  if (!vastTracker) {
    return;
  }
  vastTracker.setPaused(false);
};

/**
 * Send progress tracker(firstQuartile, midpoint...) using the vastTracker
 */
const handleTimeUpdateTrackers = () => {
  if (!vastTracker) {
    return;
  }
  vastTracker.setProgress(videoPlayer.currentTime);
};

/**
 * Send error trackers using the vastTracker
 */

const handleErrorTrackers = () => {
  if (!vastTracker) {
    return;
  }
  vastTracker.error({ ERRORCODE: 405 });
  stopAd();
};

///////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////COMPANION HANDLING////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * @returns the first valid companion creative
 */
const getCreativeCompanion = (ad) => {
  if (!ad.creatives) {
    return null;
  }

  const validCreative = ad.creatives.find(
    (creative) => creative.type === 'companion'
  );

  return validCreative || null;
};

/**
 * @returns an Object containing the image url and the variation
 */

const getVariationData = (creative) => {
  const variation = creative?.variations[0];
  const imgUrl = variation && getVariationUrl(variation);
  if (!imgUrl) {
    return null;
  }
  return { imgUrl, variation };
};

/**
 * @returns the image url of the variation to display
 */

const getVariationUrl = (variation) => {
  if (!variation.staticResources.length) {
    return null;
  }

  return variation.staticResources[0].url;
};

const displayVariation = (variationData) => {
  const { imgUrl, variation } = variationData;
  if (!variation) {
    return null;
  }
  variationImg.src = imgUrl;
  variationImg.style.height = `${variation.assetHeight}px`;
  variationImg.style.assetWIdth = `${variation.assetWidth}px`;
  variationContainer.style.display = 'block';
  variationContainer.style.width = `${variation.width}px`;
  variationContainer.style.height = `${variation.height}px`;
  variationImg.style.maxWidth = `${variation.expandedWidth}px`;
  variationImg.style.maxHeight = `${variation.expandedHeight}px`;
};
