/**
 * @namespace The action library, working with both synchronous and asynchronous actions.
 */
Action = {};

/**
 * The common states of all actions. The ordinary start state is Ready leads to only three transitions: from Ready to
 * Running, and from Running to both Done and Exception. For actions that are not fully initialized by their constructors,
 * there's also the state Init and a transition to Ready.
 * @enum {number}
 */
Action.State = {
  /**
   * An available start state for actions that use more then their constructors for initialization.
   */
  Init: 0,
  /**
   * The ordinary start state. An action is ready after it is fully initialized.
   */
  Ready: 1,
  /**
   * The subprogram of the action is currently running. The state is changed immediately upon the call to go() or run().
   */
  Running: 2,
  /**
   * The action completed without exception. In this case no catch function was called. The state is changed after the
   * subprogram has finished and before calling the finally function.
   */
  Done: 3,
  /**
   * The action threw an exception. In this case any catch function specified would be called. The state is changed
   * after the subprogram has finished and before calling the catch function.
   */
  Exception: 4
};

/**
 * The base action interface is just a marker.
 * @interface
 */
Action.Action_interface = function()
{
  /**
   * Every action is either reliable, which means that it's guaranteed to return control to the caller, or unreliable,
   * which means no such guarantee exists. Unreliable does not mean "never returns"; what would be the point of that?
   *
   * Reliability is a self-declaration for primitive actions. For composite actions, that is, actions that have at least
   * one other action within themselves, reliability can (often) be inferred.
   *
   * @expose
   * @type {boolean}
   */
  this.reliable = null;
};

/**
 *
 * @interface
 * @extends Action.Action_interface
 */
Action.Synchronous_Action_interface = function()
{
  /**
   * Every synchronous action is, by definition, reliable, since it always returns control to its caller. The return
   * of control can be either ordinary or exceptional, but that distinction is irrelevant to the meaning of "reliable".

   * @type {boolean}
   */
  this.reliable = true;
};

/**
 * The subprogram of a synchronous action is called 'run', to distinguish it from an asynchronous subprogram.
 */
Action.Synchronous_Action_interface.prototype.run = function()
{
};

//-------------------------------------------------------
/**
 * @interface
 * @extends Action.Action_interface
 */
Action.Asynchronous_Action_interface = function()
{
  /**
   * The default for an asynchronous action is unreliable. While some asynchronous actions are reliable, its prudent not
   * to assume that otherwise without specific knowledge.
   *
   * @type {boolean}
   */
  this.reliable = false;
};

Action.Asynchronous_Action_interface.prototype._go = function()
{
};


//-------------------------------------------------------
/**
 * @constructor
 */
Action.Asynchronous_Action = function()
{
};

/**
 * @this {Action.Asynchronous_Action}
 */
Action.Asynchronous_Action.init = function()
{
  /**
   * The common state of a asynchronous action
   * @type {Action.State}
   * @private
   */
  this._state = Action.State.Ready;
};

/**
 *
 * @param {function} [finally_f]
 * @param {function} [catch_f]
 */
Action.Asynchronous_Action.prototype.go = function( finally_f, catch_f )
{
  if ( this._state != Action.State.Ready )
  {
    throw new Error( "Call to go() is invalid because the action is not in state 'Ready'." );
  }
  this.finally_f = finally_f;
  this.catch_f = catch_f;
  this._state = Action.State.Running;
  this._go();
};

/**
 * Change state to Done and execute the finally function.
 *
 * @protected
 */
Action.Asynchronous_Action.prototype.end_well = function()
{
  /*
   * Note that there's no exception handling in this function. In order to mimic the behavior of the try-finally
   * statement, an exception thrown from a finally function is treated as if it had happened within a finally block,
   * which is to say, it throws the exception. There's no need for extra code to do that.
   *
   * In addition, the state is left at Done if the finally function throws an exception. In this case, the exception
   * does not come from the action itself, but from user code. So regardless of how the finally function terminates, it
   * does not change that the action completed ordinarily.
   */
  this._state = Action.State.Done;
  if ( this.finally_f ) this.finally_f();
};

/**
 * Change state to Exception and execute the catch function followed by the finally function.
 *
 * @protected
 * @param e
 *    An exception value
 */
Action.Asynchronous_Action.prototype.end_badly = function( e )
{
  /*
   * In contrast to end_well(), this function does require a try-finally statement. If the catch function throws an
   * exception, then we still have to execute the finally function anyway.
   */
  try
  {
    this._state = Action.State.Exception;
    if ( this.catch_f ) this.catch_f( e );
  }
  finally
  {
    if ( this.finally_f ) this.finally_f();
  }
};

//-------------------------------------------------------
/**
 * @interface
 * @extends Action.Action_interface
 */
Action.Joinable = function()
{
};

//-----------------------------------------------------------------------------------------
// UTILITY
//-----------------------------------------------------------------------------------------
Action.dispatch = Async_Platform.dispatch;

//-----------------------------------------------------------------------------------------
// ACTIONS
//-----------------------------------------------------------------------------------------

//-------------------------------------------------------
// Defer
//-------------------------------------------------------
/**
 * Class constructor for Defer actions, which defer execution of a function (the "trial") until after the current
 * JavaScript-thread has run to completion.
 *
 * @constructor
 * @implements Action.Asynchronous_Action_interface
 */
Action.Defer_class = function()
{
  /**
   * @const
   * @type {boolean}
   */
  this.reliable = true;
};
Action.Defer_class.prototype = new Action.Asynchronous_Action();

/**
 *
 */
Action.Defer_class.prototype._go = function()
{
  Async_Platform.dispatch( this._body.bind( this ) );
};

/**
 * The deferred trial is run inside of a try-catch-finally statement.
 * @private
 */
Action.Defer_class.prototype._body = function()
{
  try
  {
    if ( this.try_f ) this.try_f();
  }
  catch ( e )
  {
    this.end_badly( e );
    return;
  }
  this.end_well();
};

/**
 * Instance constructor for standard Defer actions.
 * @param f
 * @constructor
 */
Action.Defer = function( f )
{
  Action.Asynchronous_Action.init.call( this );
  this.try_f = f;
};
Action.Defer.prototype = new Action.Defer_class();

//-------------------------------------------------------
/**
 *
 * @constructor
 * @implements Action.Asynchronous_Action_interface
 */
Action.Delay_class = function()
{
  /**
   * Delay actions always complete, even if cancelled or aborted early.
   * @const
   * @type {boolean}
   */
  this.reliable = true;
};
Action.Delay_class.prototype = new Action.Asynchronous_Action();

/**
 * Initialization function for use by instance constructors.
 * @param f
 * @param duration
 */
Action.Delay_class.init = function( f, duration )
{
  Action.Asynchronous_Action.init.call( this );
  this.try_f = f;
  this.duration = duration;
};

Action.Delay_class.prototype._go = function()
{
  this.timer_id = Async_Platform.set_timer( this._body.bind( this ), this.duration );
};

Action.Delay_class.prototype._body = function()
{
  try
  {
    if ( this.try_f ) this.try_f();
  }
  catch ( e )
  {
    this.end_badly( e );
    return;
  }
  this.end_well();
};

/**
 * Terminate this timer without prejudice. The finally function will run as always.
 */
Action.Delay_class.prototype.cancel = function()
{
};

/**
 * Terminate a c
 */
Action.Delay_class.prototype.abort = function()
{
};


Action.Delay = function( f, duration )
{
  Action.Delay_class.init.call( this, f, duration );
};
Action.Delay.prototype = new Action.Delay_class();

//-------------------------------------------------------
/**
 *
 * @constructor
 */
Action.Join_class = function()
{
};

//-------------------------------------------------------
/**
 *
 * @interface
 */
Action.Join_Condition = function()
{
};

//-------------------------------------------------------
/**
 *
 * @implements Action.Join_Condition
 * @constructor
 * @param {Array.Joinable} actions
 */
Action.Join_Conjunction = function( actions )
{
};