package dev.paperquay.mobile;

import com.getcapacitor.BridgeActivity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

public class MainActivity extends BridgeActivity {
    private View privacyCover;

    @Override protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PaperQuayIncomingSharePlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false);
        }
    }

    @Override public void onPause() {
        // Native cover also supports API 24-32, before JS suspension. This does
        // not prohibit the user's explicit screenshots of the active reader.
        ViewGroup decor = (ViewGroup) getWindow().getDecorView();
        if (privacyCover == null) {
            privacyCover = new View(this);
            privacyCover.setTag("paperquay-privacy-cover");
            privacyCover.setBackgroundColor(Color.rgb(28, 29, 33));
            privacyCover.setContentDescription("PaperQuay 内容已隐藏");
            privacyCover.setClickable(true);
            decor.addView(privacyCover, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        privacyCover.bringToFront();
        super.onPause();
    }

    @Override public void onResume() {
        super.onResume();
        if (privacyCover != null) {
            ViewGroup parent = (ViewGroup) privacyCover.getParent();
            if (parent != null) parent.removeView(privacyCover);
            privacyCover = null;
        }
    }
}
