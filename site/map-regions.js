'use strict';

/**
 * Geometry traced against site/assets/ais-science-map-v2-lines.png (1536 × 1024).
 * Keep the raster, SVG viewBox, hotspot paths, and label coordinates aligned.
 */
module.exports = {
  width: 1536,
  height: 1024,
  regions: {
    'space-astronomy': {
      label: [15, 13],
      popover: 'below',
      path: 'M0 0H660C640 85 610 155 565 225C500 255 420 250 350 235C275 235 185 265 100 250L0 245Z',
    },
    'chemistry-materials': {
      label: [59, 12],
      popover: 'below',
      path: 'M660 0H1215C1215 120 1180 210 1120 310C1000 365 870 345 760 310C690 280 625 245 565 225C610 155 640 85 660 0Z',
    },
    'biology-genomics': {
      label: [86, 16],
      popover: 'left',
      path: 'M1215 0H1536V630C1440 645 1350 625 1260 600C1160 570 1080 545 1000 560C1040 480 1080 390 1120 310C1180 210 1215 120 1215 0Z',
    },
    'pharmacy-biomedical': {
      label: [86, 73],
      popover: 'left',
      path: 'M1000 560C1080 545 1160 570 1260 600C1350 625 1440 645 1536 630V1024H875C865 925 880 850 910 775C930 690 960 610 1000 560Z',
    },
    'food-science-technology': {
      label: [56, 88],
      popover: 'above',
      path: 'M405 650C495 610 600 600 720 625C800 640 860 690 910 775C880 850 865 925 875 1024H400C390 900 375 760 405 650Z',
    },
    'earth-climate': {
      label: [13, 72],
      popover: 'right',
      path: 'M0 430C110 420 210 430 295 480C345 525 380 585 405 650C375 760 390 900 400 1024H0Z',
    },
    mathematics: {
      label: [13, 38],
      popover: 'right',
      path: 'M0 245C100 250 190 250 270 238C350 230 430 240 500 275C475 340 425 400 365 450C345 470 320 478 295 480C210 430 110 420 0 430Z',
    },
    'ai-mathematics-data': {
      label: [38, 34],
      popover: 'right',
      path: 'M500 275C585 250 670 270 760 310C820 330 860 350 900 370C840 400 780 430 720 470C650 515 560 545 470 545C420 525 390 490 365 450C425 400 475 340 500 275Z',
    },
  },
};
