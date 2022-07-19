# milbserver

Current version 2022.07.18

Credit to https://github.com/tonycpsu/streamglob and https://github.com/mafintosh/hls-decryptor

```
npm install -g milbserver
```

## Usage

Launch the server

```
milbserver
```

and follow the prompts. Load the resulting web URL in a browser to start using the server and to see more documentation.

Basic command line options:

```
--port or -p (defaults to 9990)
--debug or -d (false if not specified)
--version or -v (returns package version number)
--logout or -l (logs out and clears session)
--session or -s (clears session)
--cache or -c (clears cache)
```

Advanced command line options:

```
--account_username (email address, default will use stored credentials or prompt user to enter them)
--account_password (default will use stored credentials or prompt user to enter them)
--multiview_port (port for multiview streaming; defaults to 1 more than primary port, or 9991)
--multiview_path (where to create the folder for multiview encoded files; defaults to app directory)
--ffmpeg_path (path to ffmpeg binary to use for multiview encoding; default downloads a binary using ffmpeg-static)
--ffmpeg_encoder (ffmpeg video encoder to use for multiview; default is the software encoder libx264)
--ffmpeg_logging (if present, logs all ffmpeg output -- useful for checking encoding speed or troubleshooting)
--page_username (username to protect pages; default is no protection)
--page_password (password to protect pages; default is no protection)
--content_protect (specify the content protection key to include as a URL parameter, if page protection is enabled)
```

For multiview, the default software encoder is limited by your CPU. You may want to experiment with different ffmpeg hardware encoders. "h264_videotoolbox" is confirmed to work on supported Macs, and "h264_v4l2m2m" is confirmed to work on a Raspberry Pi 4 (and likely other Linux systems) when ffmpeg is compiled with this patch: https://www.raspberrypi.org/forums/viewtopic.php?p=1780625#p1780625

More potential hardware encoders are described at https://stackoverflow.com/a/50703794

```
h264_amf to access AMD gpu, (windows only)
h264_nvenc use nvidia gpu cards (work with windows and linux)
h264_omx raspberry pi encoder
h264_qsv use Intel Quick Sync Video (hardware embedded in modern Intel CPU)
h264_v4l2m2m use V4L2 Linux kernel api to access hardware codecs
h264_vaapi use VAAPI which is another abstraction API to access video acceleration hardware (Linux only)
h264_videotoolbox use videotoolbox an API to access hardware on OS X
```

## License

MIT
