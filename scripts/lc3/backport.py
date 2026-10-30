"""公式LC3接続コードを、固定したFFmpeg 5.1.4のAPIへ合わせる。"""
from pathlib import Path
import sys

root = Path(sys.argv[1])
source = Path(__file__).parent


def replace(path, before, after):
    file = root / path
    text = file.read_text()
    assert text.count(before) == 1, f"移植対象が一致しません: {path}: {before}"
    file.write_text(text.replace(before, after))


for name in ("liblc3enc.c", "liblc3dec.c"):
    (root / "libavcodec" / name).write_text((source / name).read_text().replace(
        'CODEC_LONG_NAME("LC3 (Low Complexity Communication Codec)")',
        '.p.long_name = NULL_IF_CONFIG_SMALL("LC3 (Low Complexity Communication Codec)")'))
(root / "libavformat/lc3.c").write_text((source / "lc3.c").read_text())

replace("libavcodec/liblc3enc.c", "CODEC_SAMPLERATES(96000, 48000, 32000, 24000, 16000, 8000)",
        ".p.supported_samplerates = (const int[]){96000, 48000, 32000, 24000, 16000, 8000, 0}")
replace("libavcodec/liblc3enc.c", "CODEC_SAMPLEFMTS(AV_SAMPLE_FMT_FLTP, AV_SAMPLE_FMT_FLT)",
        ".p.sample_fmts = (const enum AVSampleFormat[]){AV_SAMPLE_FMT_FLTP, AV_SAMPLE_FMT_FLT, AV_SAMPLE_FMT_NONE}")
# ponytail: 5.1はAVFrame.durationがないため末尾に追加のゼロフレームを出す。
# 余白は最大1フレーム増える。新版APIへ移行したら公式のパディング判定へ戻す。
replace("libavcodec/liblc3enc.c", "int padding = frame->nb_samples - frame->duration;", "int padding = 0;")

container = root / "libavformat/lc3.c"
text = container.read_text().replace('#include "mux.h"\n', '')
text = text.replace("FFInputFormat", "AVInputFormat").replace("FFOutputFormat", "AVOutputFormat").replace(".p.", ".")
text = text.replace("    .flags_internal   = FF_OFMT_FLAG_MAX_ONE_OF_EACH |\n                        FF_OFMT_FLAG_ONLY_DEFAULT_CODECS,\n", "")
container.write_text(text)

replace("libavcodec/codec_id.h", "    AV_CODEC_ID_DFPWM,", "    AV_CODEC_ID_DFPWM,\n    AV_CODEC_ID_LC3,")
replace("libavcodec/codec_desc.c", "    /* subtitle codecs */", '''    {
        .id = AV_CODEC_ID_LC3,
        .type = AVMEDIA_TYPE_AUDIO,
        .name = "lc3",
        .long_name = NULL_IF_CONFIG_SMALL("LC3 (Low Complexity Communication Codec)"),
        .props = AV_CODEC_PROP_LOSSY,
    },

    /* subtitle codecs */''')
replace("libavcodec/allcodecs.c", "extern const FFCodec ff_libmp3lame_encoder;",
        "extern const FFCodec ff_liblc3_encoder;\nextern const FFCodec ff_liblc3_decoder;\nextern const FFCodec ff_libmp3lame_encoder;")
replace("libavformat/allformats.c", "extern const AVInputFormat  ff_wav_demuxer;",
        "extern const AVInputFormat ff_lc3_demuxer;\nextern const AVOutputFormat ff_lc3_muxer;\nextern const AVInputFormat  ff_wav_demuxer;")
with (root / "libavcodec/Makefile").open("a") as file:
    file.write("\nOBJS-$(CONFIG_LIBLC3_ENCODER) += liblc3enc.o\nOBJS-$(CONFIG_LIBLC3_DECODER) += liblc3dec.o\n")
with (root / "libavformat/Makefile").open("a") as file:
    file.write("\nOBJS-$(CONFIG_LC3_MUXER) += lc3.o\nOBJS-$(CONFIG_LC3_DEMUXER) += lc3.o\n")
replace("configure", "    libmp3lame\n", "    liblc3\n    libmp3lame\n")
replace("configure", 'libmp3lame_encoder_deps="libmp3lame"',
        'liblc3_encoder_deps="liblc3"\nliblc3_decoder_deps="liblc3"\nlibmp3lame_encoder_deps="libmp3lame"')
replace("configure", "enabled libmp3lame", "enabled liblc3 && require liblc3 lc3.h lc3_hr_setup_encoder -llc3 -lm\nenabled libmp3lame")
