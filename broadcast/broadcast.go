package broadcast

import (
	"errors"
	"sync"
)

type broadcastViewer struct {
	// This function may return `false` to signal that it cannot write any more data.
	// The stream will resynchronize at next keyframe.
	write func(data []byte) bool
	// Viewers may hop between streams, but should only receive headers once.
	// This includes track info, as codecs must stay the same between segments.
	skipHeaders bool
	// We group blocks into indeterminate-length clusters. So long as
	// the cluster's timecode has not changed, there's no need to start a new one.
	skipCluster bool
	// To avoid decoding errors due to missing reference frames, the first
	// frame of each track received by a viewer must be a keyframe.
	// Each track for which a keyframe has been sent is marked by a bit here.
	seenKeyframes uint32
}

type Broadcast struct {
	Closed   bool // When set to `true`, all viewers receive an empty bytearray as a notification.
	HasVideo bool
	HasAudio bool
	Width    uint // Dimensions of the video track that came last in the `Tracks` tag.
	Height   uint // Hopefully, there's only one video track in the file.

	vlock   sync.Mutex // protects `viewers`. not RWMutex because there's only one reader.
	viewers map[chan<- []byte]*broadcastViewer
	buffer  []byte
	header  []byte // The EBML (DocType) tag.
	tracks  []byte // The beginning of the Segment (Tracks + Info).

	time struct {
		last  uint64 // Last seen block timecode. The next timecode must be no less than that.
		recv  uint64 // Last received cluster timecode, shifted to ensure monotonicity.
		sent  uint64 // Last sent cluster timecode. (All viewers receive same clusters.)
		shift uint64 // By how much the cluster timecode has been shifted.
	}
}

func NewBroadcast() Broadcast {
	return Broadcast{viewers: make(map[chan<- []byte]*broadcastViewer)}
}

func (cast *Broadcast) Close() error {
	cast.Closed = true
	cast.vlock.Lock()
	for _, cb := range cast.viewers {
		cb.write([]byte{})
	}
	cast.vlock.Unlock()
	return nil
}

func (cast *Broadcast) Connect(ch chan<- []byte, skipHeaders bool) {
	write := func(data []byte) bool {
		// `Broadcast.Write` emits data in block-sized chunks.
		// Thus the buffer size is measured in frames, not bytes.
		if len(ch) == cap(ch) {
			return false
		}
		ch <- data
		return true
	}

	cast.vlock.Lock()
	cast.viewers[ch] = &broadcastViewer{write, skipHeaders, false, 0}
	cast.vlock.Unlock()
}

func (cast *Broadcast) Disconnect(ch chan<- []byte) {
	cast.vlock.Lock()
	delete(cast.viewers, ch)
	cast.vlock.Unlock()
}

func (cast *Broadcast) Reset() {
	cast.buffer = nil
}

func (cast *Broadcast) Write(data []byte) (int, error) {
	cast.buffer = append(cast.buffer, data...)

	for {
		buf := cast.buffer
		tag := EBMLParseTagIncomplete(buf)
		if tag.Consumed == 0 {
			return len(data), nil
		}

		if tag.ID == EBMLSegmentTag || tag.ID == EBMLTracksTag || tag.ID == EBMLClusterTag {
			// Parse the contents of these tags in the same loop.
			buf = buf[:tag.Consumed]
			// Chrome crashes if an indeterminate length is not encoded as 0xFF.
			// If we want to recode it, we'll also need some space for a Void tag.
			if tag.Length == EBMLIndeterminate && tag.Consumed >= 7 {
				cast.buffer[4] = 0xFF
				cast.buffer[5] = EBMLVoidTag
				cast.buffer[6] = 0x80 | byte(tag.Consumed-7)
			}
		} else {
			total := tag.Length + uint64(tag.Consumed)
			if total > 1024*1024 {
				return 0, errors.New("data block too big")
			}

			if total > uint64(len(buf)) {
				return len(data), nil
			}

			buf = buf[:total]
		}

		switch tag.ID {
		case EBMLSeekHeadTag:
			// Disallow seeking.
		case EBMLChaptersTag:
			// Disallow seeking again.
		case EBMLCuesTag:
			// Disallow even more seeking.
		case EBMLVoidTag:
			// Waste of space.
		case EBMLTagsTag:
			// Maybe later.
		case EBMLClusterTag:
			// Ignore boundaries, we'll regroup the data anyway.
		case EBMLPrevSizeTag:
			// Disallow backward seeking too.

		case EBMLEBMLTag:
			// The header is the same in all WebM-s.
			if len(cast.header) == 0 {
				cast.header = append([]byte{}, buf...)
			}

		case EBMLSegmentTag:
			cast.HasVideo = false
			cast.HasAudio = false
			cast.Width = 0
			cast.Height = 0
			cast.tracks = append([]byte{}, buf...)
			// Will recalculate this when the first block arrives.
			cast.time.shift = 0

		case EBMLInfoTag:
			// Default timecode resolution in Matroska is 1 ms. This value is required
			// in WebM; we'll check just in case. Obviously, our timecode rewriting
			// logic won't work with non-millisecond resolutions.
			var scale uint64 = 0

			for buf2 := tag.Contents(buf); len(buf2) != 0; {
				tag2 := EBMLParseTag(buf2)

				switch tag2.ID {
				case 0:
					return 0, errors.New("malformed EBML")

				case EBMLDurationTag:
					total := tag2.Length + uint64(tag2.Consumed) - 2
					if total > 0x7F {
						// I'd rather avoid shifting memory. What kind of integer
						// needs 128 bytes, anyway?
						return 0, errors.New("EBML Duration too large")
					}
					// Live streams must not have a duration.
					buf2[0] = EBMLVoidTag
					buf2[1] = 0x80 | byte(total)

				case EBMLTimecodeScaleTag:
					scale = EBMLParseFixedUint(tag2.Contents(buf2))
				}

				buf2 = tag2.Skip(buf2)
			}

			if scale != 1000000 {
				return 0, errors.New("invalid timecode scale")
			}

			cast.tracks = append(cast.tracks, buf...)

		case EBMLTrackEntryTag:
			// Since `viewer.seenKeyframes` is a 32-bit vector,
			// we need to check that there are at most 32 tracks.
			for buf2 := tag.Contents(buf); len(buf2) != 0; {
				tag2 := EBMLParseTag(buf2)

				switch tag2.ID {
				case 0:
					return 0, errors.New("malformed EBML")

				case EBMLTrackNumberTag:
					// go needs sizeof.
					if t := EBMLParseFixedUint(tag2.Contents(buf2)); t >= 32 {
						return 0, errors.New("too many tracks?")
					}

				case EBMLAudioTag:
					cast.HasAudio = true

				case EBMLVideoTag:
					cast.HasVideo = true
					// While we're here, let's grab some metadata, too.
					for buf3 := tag2.Contents(buf2); len(buf3) != 0; {
						tag3 := EBMLParseTag(buf3)

						switch tag3.ID {
						case 0:
							return 0, errors.New("malformed EBML")

						case EBMLPixelWidthTag:
							cast.Width = uint(EBMLParseFixedUint(tag3.Contents(buf3)))

						case EBMLPixelHeightTag:
							cast.Height = uint(EBMLParseFixedUint(tag3.Contents(buf3)))
						}

						buf3 = tag3.Skip(buf3)
					}
				}

				buf2 = tag2.Skip(buf2)
			}

			cast.tracks = append(cast.tracks, buf...)

		case EBMLTracksTag:
			cast.tracks = append(cast.tracks, buf...)

		case EBMLTimecodeTag:
			// Will reencode it when sending a Cluster.
			cast.time.recv = EBMLParseFixedUint(tag.Contents(buf)) + cast.time.shift

		case EBMLBlockGroupTag, EBMLSimpleBlockTag:
			key := false
			block := tag.Contents(buf)

			if tag.ID == EBMLBlockGroupTag {
				key, block = true, nil

				for buf2 := tag.Contents(buf); len(buf2) != 0; {
					tag2 := EBMLParseTag(buf2)

					switch tag2.ID {
					case 0:
						return 0, errors.New("malformed EBML")

					case EBMLBlockTag:
						block = tag2.Contents(buf2)

					case EBMLReferenceBlockTag:
						// Keyframes, by definition, have no reference frame.
						key = EBMLParseFixedUint(tag2.Contents(buf2)) == 0
					}

					buf2 = tag2.Skip(buf2)
				}

				if block == nil {
					return 0, errors.New("a BlockGroup contains no Blocks")
				}
			}

			track := EBMLParseUint(block)
			if track.Consumed == 0 || track.Value >= 32 || len(block) < track.Consumed+3 {
				return 0, errors.New("invalid track")
			}
			// This bit is always 0 in a Block, but 1 in a keyframe SimpleBlock.
			key = key || block[track.Consumed+2]&0x80 != 0
			// Block timecodes are relative to cluster ones.
			timecode := uint64(block[track.Consumed+0])<<8 | uint64(block[track.Consumed+1])
			if cast.time.recv+timecode < cast.time.last {
				cast.time.shift += cast.time.last - (cast.time.recv + timecode)
				cast.time.recv = cast.time.last - timecode
			}
			cast.time.last = cast.time.recv + timecode

			ctc := cast.time.recv
			cluster := []byte{
				EBMLClusterTag >> 24 & 0xFF,
				EBMLClusterTag >> 16 & 0xFF,
				EBMLClusterTag >> 8 & 0xFF,
				EBMLClusterTag & 0xFF, 0xFF,
				EBMLTimecodeTag, 0x88,
				byte(ctc >> 56), byte(ctc >> 48), byte(ctc >> 40), byte(ctc >> 32),
				byte(ctc >> 24), byte(ctc >> 16), byte(ctc >> 8), byte(ctc),
			}

			trackMask := uint32(1) << track.Value
			cast.vlock.Lock()
			for _, cb := range cast.viewers {
				if !cb.skipHeaders {
					if !cb.write(cast.header) || !cb.write(cast.tracks) {
						continue
					}

					cb.skipHeaders = true
					cb.skipCluster = false
				}

				if key {
					cb.seenKeyframes |= trackMask
				}

				if cb.seenKeyframes&trackMask != 0 {
					if !cb.skipCluster || timecode != cast.time.sent {
						cb.skipCluster = cb.write(cluster)
					}
					if !cb.skipCluster || !cb.write(buf) {
						cb.seenKeyframes &= ^trackMask
					}
				}
			}

			cast.vlock.Unlock()
			cast.time.sent = timecode

		default:
			return 0, errors.New("unknown EBML tag")
		}

		cast.buffer = cast.buffer[len(buf):]
	}
}