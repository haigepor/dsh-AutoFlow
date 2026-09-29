import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-client-ui-theme',
  ['lib/types/index.js'],
  {
    lib: {
      copy: [{
        from: 'src/styles/{brand-font.css,appearance-font.css,montserrat-*.woff2,inter-variable.woff2,noto-sans-sc-variable.woff2,source-sans-3.ttf,ibm-plex-serif-*.ttf,jetbrains-mono.ttf,ibm-plex-sans-condensed-*.ttf,Montserrat-OFL.txt,Inter-OFL.txt,NotoSansSC-OFL.txt,SourceSans3-OFL.txt,IBMPlexSerif-OFL.txt,JetBrainsMono-OFL.txt,IBMPlexSansCondensed-OFL.txt}',
        to: 'lib/styles',
      }],
    },
  },
)
