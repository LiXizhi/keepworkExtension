package com.keepwork.aipet.core

fun overlayTests(): Int {
    class Driver : OverlayDriver {
        var attaches = 0; var detaches = 0; var available = true
        override fun attach(): Boolean { attaches++; return available }
        override fun detach() { detaches++ }
    }
    run {
        val driver = Driver(); val owner = OverlayOwner(driver)
        check(!owner.show(false, true) && !owner.show(true, false) && driver.attaches == 0)
        owner.reconcile(true, true); check(!owner.showing) // Permission return is not consent to show.
        check(owner.show(true, true) && owner.show(true, true) && driver.attaches == 1)
        owner.reconcile(false, true); check(!owner.showing && driver.detaches == 1)
        owner.stop(); check(driver.detaches == 1)
        check(owner.show(true, true)); owner.reconcile(true, false)
        check(!owner.showing && driver.detaches == 2)
        owner.reconcile(true, true); check(!owner.showing)
        println("PASS overlay explicit permission/start and stop/revoke lifecycle")
    }
    run {
        val driver = Driver().apply { available = false }; val owner = OverlayOwner(driver)
        check(!owner.show(true, true) && !owner.showing)
        driver.available = true; check(owner.show(true, true)); owner.stop()
        check(driver.attaches == 2 && driver.detaches == 1)
        println("PASS overlay native rejection retains in-app fallback and allows deliberate retry")
    }
    run {
        val bounds = DragBounds(10, 20, 300, 500); val drag = OverlayDrag(8f)
        drag.down(50f,50f,Point(20,30)); check(drag.move(54f,54f,bounds) == null); check(drag.up())
        drag.down(50f,50f,Point(20,30)); check(drag.move(1000f,1000f,bounds) == Point(300,500)); check(!drag.up())
        drag.down(50f,50f,Point(20,30)); check(drag.move(-100f,-100f,bounds) == Point(10,20)); drag.cancel(); check(!drag.up())
        drag.down(50f,50f,Point(20,30)); check(drag.move(Float.NaN,0f,bounds) == null); check(!drag.up())
        check(bounds.clamp(Point(-1,1000)) == Point(10,500))
        println("PASS overlay drag threshold, edge clamp, cancellation and invalid coordinates")
    }
    run {
        val gate = OverlayStartGate("process-a")
        val stale = gate.issue(); val fresh = gate.issue()
        check(!gate.consume(stale)); check(gate.consume(fresh)); check(!gate.consume(fresh))
        val stopped = gate.issue(); gate.cancel(); check(!gate.consume(stopped))
        val recreated = OverlayStartGate("process-b"); recreated.issue()
        check(!recreated.consume(gate.issue()) && !recreated.consume(null))
        println("PASS overlay one-use start admission, stop race and process recreation fencing")
    }
    run {
        val driver = Driver(); val owner = OverlayOwner(driver)
        check(owner.show(true,true))
        // Service remains alive on Home; only service ownership/permission govern reconciliation.
        repeat(3) { owner.reconcile(true,true) }
        check(owner.showing && driver.attaches == 1 && driver.detaches == 0)
        owner.reconcile(false,true); owner.stop()
        check(!owner.showing && driver.detaches == 1)
        check(!OverlayOwner(Driver()).showing)
        println("PASS service overlay survives Activity background and cleans on revoke without resurrection")
    }
    return 5
}
