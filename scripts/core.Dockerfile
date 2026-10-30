# syntax=docker/dockerfile:1
FROM emscripten/emsdk:3.1.40 AS builder
ENV INSTALL_DIR=/opt/audio FFMPEG_ST=yes
ENV CFLAGS="-I/opt/audio/include -O3 -msimd128" CXXFLAGS="-I/opt/audio/include -O3 -msimd128"
ENV LDFLAGS="-L/opt/audio/lib -O3 -msimd128"
ENV EM_PKG_CONFIG_PATH=/opt/audio/lib/pkgconfig PKG_CONFIG_PATH=/opt/audio/lib/pkgconfig
RUN apt-get update && apt-get install -y --no-install-recommends git pkg-config autoconf automake libtool
WORKDIR /upstream
RUN git init && git remote add origin https://github.com/ffmpegwasm/ffmpeg.wasm.git && git fetch --depth=1 origin f876f907c7e9b9bf51d4ed0b913a855a63ae63fc && git checkout FETCH_HEAD
RUN mkdir /lame && cd /lame && git init && git remote add origin https://github.com/ffmpegwasm/lame.git && git fetch --depth=1 origin 2badea1974ae36cb8312afe99cff1e6b3b5decee && git checkout FETCH_HEAD && bash /upstream/build/lame.sh
RUN git clone --depth=1 -b v1.3.4 https://github.com/ffmpegwasm/Ogg.git /ogg && cd /ogg && bash /upstream/build/ogg.sh
RUN git clone --depth=1 -b v1.3.1 https://github.com/ffmpegwasm/opus.git /opus && cd /opus && bash /upstream/build/opus.sh
RUN git clone --depth=1 -b v1.3.3 https://github.com/ffmpegwasm/vorbis.git /vorbis && cd /vorbis && bash /upstream/build/vorbis.sh
RUN git clone --depth=1 -b n5.1.4 https://github.com/FFmpeg/FFmpeg.git /src
WORKDIR /src
RUN bash /upstream/build/ffmpeg.sh --disable-everything --disable-network --enable-libmp3lame --enable-libopus --enable-libvorbis \
    --enable-protocol=file,pipe \
    --enable-decoder=aac,aac_fixed,mp3,mp3float,mp2,mp2float,libopus,vorbis,flac,adpcm_g722,adpcm_ima_wav,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be \
    --enable-encoder=libmp3lame,libopus,libvorbis,aac,flac,adpcm_g722,adpcm_ima_wav,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le \
    --enable-demuxer=wav,aiff,flac,mp3,aac,mov,ogg,matroska,pcm_f32le \
    --enable-muxer=wav,flac,mp3,ipod,ogg,pcm_f32le,null \
    --enable-parser=aac,mpegaudio,opus,vorbis,flac \
    --enable-filter=abuffer,abuffersink,aformat,aeval,aresample,atrim,asetpts,ashowinfo,anull
RUN cp -R /upstream/src/bind /upstream/src/fftools /src/ && mkdir -p src && mv bind fftools src/
# 音声構成では無効なGPL映像後処理ライブラリをリンク対象から外す。
# スタック容量（5MB）などは上流の修正をそのまま使用する。
RUN sed '/^[[:space:]]*-lpostproc[[:space:]]*$/d' /upstream/build/ffmpeg-wasm.sh > /src/link.sh && mkdir -p dist/umd dist/esm && bash /src/link.sh -lmp3lame -logg -lvorbis -lvorbisenc -lvorbisfile -lopus -o dist/umd/ffmpeg-core.js && bash /src/link.sh -lmp3lame -logg -lvorbis -lvorbisenc -lvorbisfile -lopus -sEXPORT_ES6 -o dist/esm/ffmpeg-core.js
RUN printf '{"type":"commonjs"}\n' > dist/package.json && mkdir -p dist/licenses && cp /upstream/LICENSE dist/licenses/ffmpeg-wasm.txt && cp COPYING.LGPLv2.1 dist/licenses/ffmpeg.txt && cp /lame/COPYING dist/licenses/lame.txt && cp /opus/COPYING dist/licenses/opus.txt && cp /ogg/COPYING dist/licenses/ogg.txt && cp /vorbis/COPYING dist/licenses/vorbis.txt
FROM scratch AS output
COPY --from=builder /src/dist/ /
