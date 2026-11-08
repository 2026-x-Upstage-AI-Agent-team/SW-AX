import kr.dogfoot.hwp2hwpx.Hwp2Hwpx;
import kr.dogfoot.hwplib.reader.HWPReader;
import kr.dogfoot.hwpxlib.writer.HWPXWriter;

class ConvertHwp {
    public static void main(String[] paths) throws Exception {
        for (int i = 0; i < paths.length; i += 2) {
            HWPXWriter.toFilepath(Hwp2Hwpx.toHWPX(HWPReader.fromFile(paths[i])), paths[i + 1]);
        }
    }
}
