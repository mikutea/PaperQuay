package dev.paperquay.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PaperQuayIncomingSharePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
